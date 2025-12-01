require('dotenv').config();
const express = require('express');
const { S3Client } = require("@aws-sdk/client-s3");
const { SQSClient } = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const Redis = require("ioredis");
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 8080;

// AWS Clients 초기화
const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const db = new DynamoDBClient({ region: process.env.AWS_REGION });

// Redis Client (결과 구독용)
// 1. 변수가 들어왔는지 확인 (로그에 찍힘)
console.log("👉 [DEBUG] REDIS_HOST:", process.env.REDIS_HOST);

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: 6379,
    // (이전 커밋에 retryStrategy 논의되었으나, 초기 버전에서는 주석 처리됨)
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


// 서버 시작
app.listen(PORT, () => {
    console.log(`🚀 NanoGrid Controller running on port ${PORT}`);
    console.log(`   - Mode: EC2 Native (No Lambda)`);
});