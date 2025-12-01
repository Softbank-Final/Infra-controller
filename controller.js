require('dotenv').config();
const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const Redis = require("ioredis");
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 8080;

// AWS Clients
const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const db = new DynamoDBClient({ region: process.env.AWS_REGION });

// Redis Client (결과 구독용)
// 1. 변수가 들어왔는지 확인 (로그에 찍힘)
console.log("👉 [DEBUG] REDIS_HOST:", process.env.REDIS_HOST);

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: 6379,
    // // 연결 끊겨도 죽지 않고 재시도하게 설정
    // retryStrategy: times => Math.min(times * 50, 2000)
});

// 2. 에러가 나도 프로세스가 죽지 않도록 방지망 설치
redis.on('error', (err) => {
    console.error("❌ Global Redis Error (무시됨):", err.message);
});

redis.on('connect', () => {
    console.log("✅ Global Redis Connected!");
});

app.use(express.json());

// 헬스 체크 API (로드 밸런서 Target Group용)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 1. 코드 업로드 (POST /upload)
const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.BUCKET_NAME,
        key: function (req, file, cb) {
            const functionId = uuidv4();
            req.functionId = functionId; // 나중에 DB 저장할 때 쓰려고
            cb(null, `functions/${functionId}/v1.zip`); // S3 Key 경로
        }
    })
});

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const functionId = req.functionId;
        const s3Key = req.file.key;
        
        // 메타데이터 DB 저장
        await db.send(new PutItemCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
                functionId: { S: functionId },
                s3Key: { S: s3Key },
                runtime: { S: req.body.runtime || "python" },
                uploadedAt: { S: new Date().toISOString() }
            }
        }));

        console.log(`[Upload] Success: ${functionId}`);
        res.json({ success: true, functionId: functionId });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});


// 2. 함수 실행 (POST /run)
app.post('/run', async (req, res) => {
    const { functionId, inputData } = req.body;
    const requestId = uuidv4();

    console.log(`[Run] Request: ${requestId} (Func: ${functionId})`);

    try {
        // A. 함수 정보 조회
        const { Item } = await db.send(new GetItemCommand({
            TableName: process.env.TABLE_NAME,
            Key: { functionId: { S: functionId } }
        }));

        if (!Item) return res.status(404).json({ error: "Function not found" });

        // B. SQS에 작업 전송 (Data Plane 규격 준수)
        const taskPayload = {
            requestId: requestId,
            functionId: functionId,
            runtime: Item.runtime.S,
            s3Bucket: process.env.BUCKET_NAME,
            s3Key: Item.s3Key.S,
            timeoutMs: 5000,
            memoryMb: 256,
            input: inputData || {}
        };

        await sqs.send(new SendMessageCommand({
            QueueUrl: process.env.SQS_URL,
            MessageBody: JSON.stringify(taskPayload)
        }));

        // C. Redis Pub/Sub으로 결과 대기 (Async -> Sync 변환)
        const result = await waitForResult(requestId);
        res.json(result);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Redis 대기 헬퍼 함수
function waitForResult(requestId) {
    return new Promise((resolve, reject) => {
        const sub = new Redis({ host: process.env.REDIS_HOST, port: 6379 });
        const channel = `result:${requestId}`;
        let completed = false;

        // 25초 타임아웃
        const timeout = setTimeout(() => {
            if (!completed) {
                cleanup();
                resolve({ status: "TIMEOUT", message: "Execution timed out" });
            }
        }, 25000);

        function cleanup() {
            completed = true;
            clearTimeout(timeout);
            sub.disconnect();
        }

        sub.subscribe(channel);
        sub.on('message', (chn, msg) => {
            if (chn === channel) {
                cleanup();
                try { resolve(JSON.parse(msg)); } catch (e) { resolve({ raw: msg }); }
            }
        });
    });
}

app.listen(PORT, () => {
    console.log(`🚀 NanoGrid Controller running on port ${PORT}`);
    console.log(`   - Mode: EC2 Native (No Lambda)`);
});