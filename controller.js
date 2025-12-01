require('dotenv').config();
const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require("@aws-sdk/client-s3");
const { SQSClient } = require("@aws-sdk/client-sqs");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const Redis = require("ioredis");
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 8080;

// AWS Clients 초기화
const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const db = new DynamoDBClient({ region: process.env.AWS_REGION });

// Redis Client (결과 구독용)
console.log("👉 [DEBUG] REDIS_HOST:", process.env.REDIS_HOST);
const redis = new Redis({ host: process.env.REDIS_HOST, port: 6379 });

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

// 1. 코드 업로드 (POST /upload) - Resource Manager 역할
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
        
        // 메타데이터 DB 저장 (Metadata Recorder)
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


// 서버 시작
app.listen(PORT, () => {
    console.log(`🚀 NanoGrid Controller running on port ${PORT}`);
    console.log(`   - Mode: EC2 Native (No Lambda)`);
});