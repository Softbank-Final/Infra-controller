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
const PORT = 8080; // ALB Target Group 설정을 이 포트(8080)로 맞춰야 합니다
const VERSION = "v2.2 (Enterprise Edition)";

// [Logger] 구조화된 JSON 로깅 유틸리티 (CloudWatch 검색 최적화)
const logger = {
    info: (msg, context = {}) => console.log(JSON.stringify({ level: 'INFO', timestamp: new Date(), msg, ...context })),
    warn: (msg, context = {}) => console.warn(JSON.stringify({ level: 'WARN', timestamp: new Date(), msg, ...context })),
    error: (msg, error = {}) => console.error(JSON.stringify({ level: 'ERROR', timestamp: new Date(), msg, error: error.message || error, stack: error.stack }))
};

// Fail-Fast: 필수 환경변수 검증
const REQUIRED_ENV = ['AWS_REGION', 'BUCKET_NAME', 'TABLE_NAME', 'SQS_URL', 'REDIS_HOST', 'NANOGRID_API_KEY'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    logger.error(`FATAL: Missing environment variables`, { missing: missingEnv });
    process.exit(1);
}

// AWS Clients
const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const db = new DynamoDBClient({ region: process.env.AWS_REGION });

// Redis Client
logger.info("Initializing Redis Client", { host: process.env.REDIS_HOST });

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: 6379,
    retryStrategy: times => Math.min(times * 50, 2000),
    maxRetriesPerRequest: null
});

let isRedisConnected = false;

redis.on('error', (err) => {
    isRedisConnected = false;
    logger.error("Global Redis Connection Error", err);
});

redis.on('connect', () => {
    isRedisConnected = true;
    logger.info("Global Redis Connected Successfully");
});

app.use(express.json());

// [Security Middleware 1] 인증 (Authentication)
const authenticate = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];
    const serverKey = process.env.NANOGRID_API_KEY;

    if (!clientKey || clientKey !== serverKey) {
        logger.warn("Unauthorized access attempt", { ip: req.ip, headers: req.headers });
        return res.status(401).json({ error: "Unauthorized: Invalid or missing API Key" });
    }
    next();
};

// [Security Middleware 2] Atomic Rate Limiting (via Lua Script)
// 1분(60초)에 최대 100회 요청 허용
const RATE_LIMIT_WINDOW = 60; 
const RATE_LIMIT_MAX = 100;

// Lua Script: 원자성 보장 (INCR와 EXPIRE를 한 번에 실행)
const RATE_LIMIT_SCRIPT = `
    local current = redis.call("INCR", KEYS[1])
    if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
    end
    return current
`;

const rateLimiter = async (req, res, next) => {
    try {
        const ip = req.ip || req.connection.remoteAddress;
        const key = `ratelimit:${ip}`;
        
        // Lua Script 실행 (Atomic Operation)
        const current = await redis.eval(RATE_LIMIT_SCRIPT, 1, key, RATE_LIMIT_WINDOW);
        
        // 헤더 정보 제공
        res.set('X-RateLimit-Limit', RATE_LIMIT_MAX);
        res.set('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - current));

        if (current > RATE_LIMIT_MAX) {
            logger.warn("Rate limit exceeded", { ip, count: current });
            return res.status(429).json({ 
                error: "Too Many Requests", 
                message: "Please slow down. You have exceeded the rate limit." 
            });
        }
        
        next();
    } catch (error) {
        // Redis 장애 시 서비스는 계속되어야 함 (Fail Open)
        logger.error("Rate Limiter Error", error);
        next();
    }
};

// 0. 상세 헬스 체크 (ALB Target Group이 8080 포트로 찔러야 함)
app.get('/health', (req, res) => {
    // Redis가 끊기면 Unhealthy(503)를 반환하여 트래픽 차단
    const status = isRedisConnected ? 200 : 503;
    const responseData = {
        status: isRedisConnected ? 'OK' : 'ERROR',
        redis: isRedisConnected,
        version: VERSION,
        uptime: process.uptime()
    };
    
    // 헬스 체크 로그는 너무 자주 찍히면 시끄러우므로 503일 때만 에러 로그
    if (!isRedisConnected) logger.warn("Health Check Failed", responseData);
    
    res.status(status).json(responseData);
});

// 1. 코드 업로드
app.post('/upload', authenticate, rateLimiter, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "File upload failed or no file provided" });
        }

        const safeString = (val, defaultVal) => {
            if (val === undefined || val === null) return defaultVal;
            const str = String(val).trim();
            return str.length > 0 ? str : defaultVal;
        };

        const body = req.body || {};
        const functionId = safeString(req.functionId, uuidv4());
        const fallbackKey = `functions/${functionId}/v1.zip`;
        const s3Key = safeString(req.file.key, fallbackKey);
        
        const originalName = safeString(req.file.originalname, "unknown_file.zip");
        const description = safeString(body.description, "No description provided");
        const runtime = safeString(body.runtime, "python");

        const itemToSave = {
            functionId: { S: functionId },
            s3Key: { S: s3Key },
            originalName: { S: originalName },
            description: { S: description },
            runtime: { S: runtime },
            uploadedAt: { S: new Date().toISOString() }
        };

        logger.info("Saving metadata to DynamoDB", { functionId, item: itemToSave });

        await db.send(new PutItemCommand({
            TableName: process.env.TABLE_NAME,
            Item: itemToSave
        }));

        logger.info(`Upload Success`, { functionId });
        res.json({ success: true, functionId: functionId });

    } catch (error) {
        logger.error("Upload Error", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 함수 실행
app.post('/run', authenticate, rateLimiter, async (req, res) => {
    const { functionId, inputData } = req.body || {};
    
    if (!functionId) {
        return res.status(400).json({ error: "functionId is required" });
    }

    const requestId = uuidv4();
    logger.info(`Run Request Received`, { requestId, functionId });

    try {
        const { Item } = await db.send(new GetItemCommand({
            TableName: process.env.TABLE_NAME,
            Key: { functionId: { S: functionId } }
        }));

        if (!Item) {
            logger.warn("Function not found in DB", { functionId });
            return res.status(404).json({ error: "Function not found" });
        }

        const taskPayload = {
            requestId: requestId,
            functionId: functionId,
            runtime: Item.runtime ? Item.runtime.S : "python", 
            s3Bucket: process.env.BUCKET_NAME,
            s3Key: Item.s3Key ? Item.s3Key.S : "",
            timeoutMs: 5000,
            memoryMb: 256,
            input: inputData || {}
        };

        await sqs.send(new SendMessageCommand({
            QueueUrl: process.env.SQS_URL,
            MessageBody: JSON.stringify(taskPayload)
        }));

        const result = await waitForResult(requestId);
        res.json(result);

    } catch (error) {
        logger.error("Run Error", error);
        res.status(500).json({ error: error.message });
    }
});

function waitForResult(requestId) {
    return new Promise((resolve, reject) => {
        const sub = new Redis({ 
            host: process.env.REDIS_HOST, 
            port: 6379,
            retryStrategy: null 
        });
        
        const channel = `result:${requestId}`;
        let completed = false;

        const timeout = setTimeout(() => {
            if (!completed) {
                cleanup();
                logger.warn("Execution Timed Out", { requestId });
                resolve({ status: "TIMEOUT", message: "Execution timed out" });
            }
        }, 25000);

        function cleanup() {
            completed = true;
            clearTimeout(timeout);
            try {
                sub.disconnect();
            } catch (e) { /* ignore */ }
        }

        sub.subscribe(channel, (err) => {
            if (err) {
                cleanup();
                logger.error("Redis Subscribe Failed", err);
                resolve({ status: "ERROR", message: "Redis subscribe failed" });
            }
        });

        sub.on('message', (chn, msg) => {
            if (chn === channel) {
                cleanup();
                try { resolve(JSON.parse(msg)); } catch (e) { resolve({ raw: msg }); }
            }
        });
    });
}

const server = app.listen(PORT, () => {
    logger.info(`NanoGrid Controller ${VERSION} Started`, { port: PORT, mode: 'EC2 Native' });
});

const gracefulShutdown = () => {
    logger.info('Received kill signal, shutting down gracefully');
    server.close(() => {
        logger.info('Closed out remaining connections');
        redis.quit();
        process.exit(0);
    });

    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);