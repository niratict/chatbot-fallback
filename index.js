require("dotenv").config();
const express = require("express");
const { WebhookClient } = require("dialogflow-fulfillment");
const admin = require("firebase-admin");
const winston = require("winston");
const { format } = require("winston");

// สร้าง logger ที่มีการจัดรูปแบบที่ดีขึ้น
const logger = winston.createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: "fallback-chatbot" },
  transports: [
    new winston.transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf((info) => {
          const { timestamp, level, message, ...rest } = info;
          const restString = Object.keys(rest).length
            ? JSON.stringify(rest, null, 2)
            : "";
          return `${timestamp} ${level}: ${message} ${restString}`;
        })
      ),
    }),
    // คุณสามารถเพิ่ม transports อื่น ๆ ได้ที่นี่ เช่น File transport
    // new winston.transports.File({ filename: 'error.log', level: 'error' }),
    // new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// ตรวจสอบ environment variables ที่จำเป็น
const requiredEnvVars = [
  "FIREBASE_TYPE",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_DATABASE_URL",
];

requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    logger.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

// กำหนดค่า Firebase Service Account
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

// เริ่มการเชื่อมต่อ Firebase
logger.info("Attempting to connect to Firebase...", {
  projectId: serviceAccount.project_id,
  clientEmail: serviceAccount.client_email,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

let db;
try {
  // เริ่มต้นการเชื่อมต่อ Firebase
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

  db = admin.database();

  // ทดสอบการเชื่อมต่อและการเขียนข้อมูล
  db.ref(".info/connected").on("value", async (snapshot) => {
    if (snapshot.val() === true) {
      logger.info("Connected to Firebase Realtime Database");

      try {
        // ทดสอบเขียนข้อมูล
        await db.ref("system_status").set({
          last_connection: new Date().toISOString(),
          status: "online",
          server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          server_timestamp: Date.now(),
        });
        logger.info("Firebase write test successful");
      } catch (writeError) {
        logger.error("Firebase write test failed", {
          error: writeError.toString(),
        });
      }
    } else {
      logger.warn("Disconnected from Firebase Realtime Database");
    }
  });

  // ทดสอบการอ่านข้อมูล
  db.ref("system_status")
    .once("value")
    .then(() => logger.info("Firebase read test successful"))
    .catch((error) =>
      logger.error("Firebase read test failed", { error: error.toString() })
    );
} catch (initError) {
  logger.error("Firebase initialization error", {
    error: initError.toString(),
  });
  process.exit(1);
}

// ฟังก์ชันสำหรับแปลงเวลาเป็นเวลาประเทศไทย
function getThaiTime() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
  );
}

// ฟังก์ชันสำหรับฟอร์แมตเวลาไทยให้เป็นรูปแบบที่อ่านง่าย
function formatThaiTime(date) {
  return date.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// เพิ่มฟังก์ชันตรวจสอบเวลาทำการ (เวลาไทย)
function isWithinBusinessHours() {
  const thaiTime = getThaiTime();
  const day = thaiTime.getDay(); // 0 = อาทิตย์, 1-6 = จันทร์-เสาร์
  const hour = thaiTime.getHours();
  const minutes = thaiTime.getMinutes();
  const currentTime = hour + minutes / 60;

  logger.debug("Checking business hours", {
    thaiTime: formatThaiTime(thaiTime),
    day: day,
    hour: hour,
    minutes: minutes,
    currentTime: currentTime,
  });

  // วันอาทิตย์ (9:00-18:00)
  if (day === 0) {
    return currentTime >= 9 && currentTime < 18;
  }
  // วันจันทร์-เสาร์ (9:00-24:00)
  else if (day >= 1 && day <= 6) {
    return currentTime >= 9 && currentTime < 24;
  }
  return false;
}

// ตั้งค่า Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware สำหรับ logging requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(
      `${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`
    );
  });
  next();
});

// สร้าง local server cache เพื่อลดการเรียกใช้ Firebase บ่อยเกินไป
const userCooldownCache = new Map();

// ฟังก์ชันสำหรับ clean cache ทุก ๆ ระยะเวลาที่กำหนด
function cleanCooldownCache() {
  const now = Date.now();
  let cleanedCount = 0;

  userCooldownCache.forEach((data, userId) => {
    // ถ้าผ่านไปเกิน 10 นาทีแล้ว ให้ลบออกจาก cache
    if (now - data.timestamp > 10 * 60 * 1000) {
      userCooldownCache.delete(userId);
      cleanedCount++;
    }
  });

  if (cleanedCount > 0) {
    logger.debug(`Cleaned ${cleanedCount} entries from cooldown cache`);
  }
}

// ตั้งเวลาให้ทำการ clean cache ทุก ๆ 5 นาที
setInterval(cleanCooldownCache, 5 * 60 * 1000);

// Route สำหรับตรวจสอบสถานะเซิร์ฟเวอร์
app.get("/", (req, res) => {
  const thaiTime = getThaiTime();
  res.send({
    status: "online",
    timestamp: new Date().toISOString(),
    thai_timestamp: thaiTime.toISOString(),
    thai_time_formatted: formatThaiTime(thaiTime),
    service: "Dialogflow Webhook",
    environment: process.env.NODE_ENV || "development",
    firebase_status: db ? "initialized" : "not_initialized",
    business_hours: isWithinBusinessHours() ? "open" : "closed",
    cache_size: userCooldownCache.size,
  });
});

// ฟังก์ชันสำหรับตรวจสอบและอัพเดต cooldown ของผู้ใช้
async function checkAndUpdateCooldown(userId, forceReset = false) {
  const COOLDOWN_PERIOD = 300000; // 5 นาที
  const now = Date.now();

  // ตรวจสอบว่ามีข้อมูลใน cache หรือไม่
  if (userCooldownCache.has(userId) && !forceReset) {
    const cachedData = userCooldownCache.get(userId);

    // ถ้ายังอยู่ในช่วง cooldown ให้คืนค่า false
    if (now - cachedData.timestamp < COOLDOWN_PERIOD) {
      return {
        canSendMessage: false,
        lastTime: cachedData.timestamp,
        timeLeft: COOLDOWN_PERIOD - (now - cachedData.timestamp),
      };
    }
  }

  try {
    // ดึงข้อมูลจาก Firebase
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once("value");
    const userData = snapshot.val() || {};
    const lastFallbackTime = userData.lastFallbackTime || 0;

    // ตรวจสอบ cooldown จากข้อมูลใน Firebase
    if (now - lastFallbackTime < COOLDOWN_PERIOD && !forceReset) {
      // อัพเดต cache
      userCooldownCache.set(userId, {
        timestamp: lastFallbackTime,
        lastUpdated: now,
      });

      return {
        canSendMessage: false,
        lastTime: lastFallbackTime,
        timeLeft: COOLDOWN_PERIOD - (now - lastFallbackTime),
      };
    }

    // อัพเดตข้อมูลใน Firebase
    await userRef.update({
      lastFallbackTime: now,
      lastUpdated: getThaiTime().toISOString(),
      userId: userId,
      cooldownResetCount:
        (userData.cooldownResetCount || 0) + (forceReset ? 1 : 0),
      totalFallbacks: (userData.totalFallbacks || 0) + 1,
    });

    // อัพเดต cache
    userCooldownCache.set(userId, {
      timestamp: now,
      lastUpdated: now,
    });

    return {
      canSendMessage: true,
      lastTime: now,
      timeLeft: 0,
    };
  } catch (error) {
    logger.error("Error checking cooldown", {
      userId,
      error: error.toString(),
      stack: error.stack,
    });

    // ถ้าเกิดข้อผิดพลาด ให้อนุญาตให้ส่งข้อความได้เพื่อป้องกันการติดค้าง
    return {
      canSendMessage: true,
      lastTime: now,
      timeLeft: 0,
      error: true,
    };
  }
}

// Webhook endpoint สำหรับ Dialogflow
app.post("/webhook", async (req, res) => {
  const thaiTime = getThaiTime();
  logger.info("Received webhook request", {
    timestamp: thaiTime.toISOString(),
    thai_time: formatThaiTime(thaiTime),
    body: req.body,
  });

  const agent = new WebhookClient({ request: req, response: res });

  // ฟังก์ชันจัดการ Fallback Intent
  async function handleFallback(agent) {
    try {
      const userId =
        agent.originalRequest?.payload?.data?.source?.userId ||
        agent.originalRequest?.payload?.userId ||
        `anonymous-${Date.now()}`;

      logger.info(`Processing fallback for user`, { userId });

      // ตรวจสอบสถานะ cooldown
      const cooldownStatus = await checkAndUpdateCooldown(userId);

      if (cooldownStatus.canSendMessage) {
        // ตรวจสอบเวลาทำการและส่งข้อความตามเงื่อนไข
        if (isWithinBusinessHours()) {
          agent.add(
            "รบกวนคุณลูกค้ารอเจ้าหน้าที่ฝ่ายบริการตอบกลับอีกครั้งนะคะ คุณลูกค้าสามารถพิมพ์คำถามไว้ได้เลยค่ะ"
          );
        } else {
          agent.add(
            "รบกวนคุณลูกค้ารอเจ้าหน้าที่ฝ่ายบริการตอบกลับอีกครั้งนะคะ ทั้งนี้เจ้าหน้าที่ฝ่ายบริการทำการจันทร์-เสาร์ เวลา 09.00-00.00 น. และวันอาทิตย์ทำการเวลา 09.00-18.00 น. ค่ะ"
          );
        }
        logger.info(`Updated fallback time for user`, {
          userId,
          cooldownApplied: true,
          resetTime: new Date(Date.now() + 300000).toISOString(),
        });
      } else {
        // อยู่ในช่วง cooldown ไม่ส่งข้อความ
        agent.add("");
        logger.info(`User is in cooldown period`, {
          userId,
          timeLeft: Math.round(cooldownStatus.timeLeft / 1000) + " seconds",
          lastFallbackTime: new Date(cooldownStatus.lastTime).toISOString(),
        });
      }
    } catch (error) {
      logger.error("Error in handleFallback", {
        error: error.toString(),
        stack: error.stack,
      });
      agent.add("ขออภัย เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  // ฟังก์ชันรีเซ็ต cooldown (สำหรับเจ้าหน้าที่หรือการทดสอบ)
  async function handleResetCooldown(agent) {
    try {
      const userId =
        agent.originalRequest?.payload?.data?.source?.userId ||
        agent.originalRequest?.payload?.userId ||
        `anonymous-${Date.now()}`;

      logger.info(`Resetting cooldown for user`, { userId });

      await checkAndUpdateCooldown(userId, true);

      agent.add("รีเซ็ต cooldown สำเร็จ");
    } catch (error) {
      logger.error("Error in handleResetCooldown", {
        error: error.toString(),
        stack: error.stack,
      });
      agent.add("ขออภัย ไม่สามารถรีเซ็ต cooldown ได้");
    }
  }

  const intentMap = new Map();
  intentMap.set("Default Fallback Intent", handleFallback);
  intentMap.set("Reset Cooldown", handleResetCooldown); // เพิ่ม intent สำหรับรีเซ็ต cooldown

  try {
    await agent.handleRequest(intentMap);
  } catch (error) {
    logger.error("Error handling webhook request", {
      error: error.toString(),
      stack: error.stack,
    });
    res.status(500).send({ error: "Internal server error" });
  }
});

// เริ่มต้น server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  const thaiTime = getThaiTime();
  logger.info(`Server started`, {
    port: port,
    environment: process.env.NODE_ENV || "development",
    firebaseProject: process.env.FIREBASE_PROJECT_ID,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    serverTime: new Date().toISOString(),
    thaiTime: formatThaiTime(thaiTime),
  });
});

// ฟังก์ชันสำหรับการ graceful shutdown
function gracefulShutdown(signal) {
  return () => {
    logger.info(`${signal} received, shutting down gracefully`);

    // อัพเดตสถานะใน Firebase ว่า offline
    if (db) {
      db.ref("system_status")
        .update({
          status: "offline",
          last_shutdown: new Date().toISOString(),
          shutdown_reason: signal,
        })
        .then(() => {
          logger.info("Updated offline status in Firebase");
          process.exit(0);
        })
        .catch((err) => {
          logger.error("Failed to update offline status in Firebase", {
            error: err.toString(),
          });
          process.exit(1);
        });
    } else {
      process.exit(0);
    }

    // ถ้าไม่สามารถปิดการเชื่อมต่อได้ภายใน 5 วินาที ให้บังคับปิด
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
  };
}

// จัดการ graceful shutdown
process.on("SIGTERM", gracefulShutdown("SIGTERM"));
process.on("SIGINT", gracefulShutdown("SIGINT"));

// จัดการ uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception", {
    error: error.toString(),
    stack: error.stack,
  });
  // อัพเดตสถานะ error ใน Firebase
  if (db) {
    db.ref("system_errors")
      .push({
        timestamp: new Date().toISOString(),
        thai_time: formatThaiTime(getThaiTime()),
        error: error.toString(),
        stack: error.stack,
      })
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled Rejection", {
    error: error.toString(),
    stack: error.stack,
  });
  // อัพเดตสถานะ error ใน Firebase
  if (db) {
    db.ref("system_errors").push({
      timestamp: new Date().toISOString(),
      thai_time: formatThaiTime(getThaiTime()),
      error: error.toString(),
      stack: error.stack,
    });
  }
});
