/** @format */

import { dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import bodyParser from "body-parser";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import cluster from "cluster";
import os from "os";
import pLimit from "p-limit";
import axiosInstance from "./utils/axios.js";
import axios from "axios";
let numCPUs = os.cpus().length;
let PORT = 8080;
let __dirname = dirname(fileURLToPath(import.meta.url));
import nodemailer from "nodemailer";

let retryGoto = async (page, url, retries = 4) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } catch (e) {
      if (i === retries - 1) throw e;
    }
  }
};

let sendEmailWithDownloadLink = async (
  productUrl,
  productTitle,
  email,
  downloadUrl
) => {
  let transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
      user: "crawlclipart@gmail.com",
      pass: "wsxy qyiu gneo crks",
    },
  });

  await transporter.sendMail({
    from: '"Clipart Service" crawlclipart@gmail.com',
    to: email,
    subject: `🎁 File clipart của ${productTitle} đã sẵn sàng`,
    html: `
      <div style="max-width:650px;margin:auto;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1);font-family:'Poppins',sans-serif;color:#334155;">
        <div style="background-color:#f8fafc;border-bottom:1px solid #e2e8f0;padding:30px;text-align:center;">
          <img src="https://crawlclipart.com/logo.png" alt="Clipart Service Logo" style="width:150px;height:auto;margin-bottom:15px;">
        </div>
        <div style="padding:40px 30px;">
          <h1 style="font-size:22px;font-weight:600;color:#3b82f6;margin-bottom:20px;">Xử lý file clipart hoàn tất!</h1>
          <p style="margin-bottom:16px;font-size:15px;">File clipart từ Product <a href="${productUrl}" style="color:#2563eb;" target="_blank">${productTitle}</a> của bạn đã được xử lý xong.</p>
          <p style="margin-bottom:16px;font-size:15px;">Bạn có thể tải về tập tin đã xử lý bằng cách nhấp vào Link bên dưới:</p>
          <div style="background-color:#f1f5f9;border-left:4px solid #3b82f6;border-radius:10px;padding:15px;margin:25px 0;word-break:break-word;">
            <p style="margin:0;"><a href="${downloadUrl}" target="_blank" style="color:#2563eb;">${downloadUrl}</a></p>
          </div>
          <div style="background-color:#fef2f2;border-left:4px solid #ef4444;border-radius:10px;padding:15px;display:flex;align-items:center;margin:25px 0;">
            <div style="margin-right:12px;font-size:20px;color:#ef4444;min-width:24px;">⚠️</div>
            <p style="margin:0;font-size:14px;color:#b91c1c;font-weight:500;">Lưu ý: Link tải sẽ được xóa sau khi tải xong.</p>
          </div>
          <p style="margin-bottom:16px;font-size:15px;">Nếu bạn gặp bất kỳ vấn đề nào trong quá trình tải xuống, vui lòng liên hệ với chúng tôi qua email <a href="mailto:andendo1699@gmail.com" style="color:#2563eb;">andendo1699@gmail.com</a> hoặc số điện thoại <a href="tel:0327238659" style="color:#2563eb;">0327238659</a>.</p>
          <p style="margin-bottom:0;font-size:15px;">Trân trọng,<br>Clipart Service</p>
        </div>
        <div style="text-align:center;padding:25px 30px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="font-size:14px;color:#64748b;margin:0 0 10px;">© 2025 Clipart Service. Made by Anden.</p>
          <div style="margin:15px auto 0;">
            <a href="https://www.facebook.com/andendo1699" style="margin:0 8px;" target="_blank"><img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="24" height="24" alt="Facebook" style="border-radius:50%;"></a>
            <a href="tel:0327238659" style="margin:0 8px;"><img src="https://cdn-icons-png.flaticon.com/512/597/597177.png" width="24" height="24" alt="Phone" style="border-radius:50%;"></a>
            <a href="mailto:andendo1699@gmail.com" style="margin:0 8px;"><img src="https://cdn-icons-png.flaticon.com/512/732/732200.png" width="24" height="24" alt="Email" style="border-radius:50%;"></a>
          </div>
        </div>
      </div>
    `,
  });
};

async function waitUntilStable(page, selector, stableTime = 2000, checkInterval = 300) {
  let lastCount = 0;
  let stableFor = 0;

  while (true) {
    const els = await page.$$(selector);
    const count = els.length;

    if (count === lastCount) {
      stableFor += checkInterval;
    } else {
      stableFor = 0;
      lastCount = count;
    }

    if (stableFor >= stableTime) {
      return els; // trả về khi ổn định
    }

    await new Promise((r) => setTimeout(r, checkInterval));
  }
}

export async function crawlPersonalizedOptions(page, productUrl, newdirname) {
  let collected = new Set();
  let clickedImgs = new Set();
  let changedSelects = new Set();

  // Bắt response ảnh
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("assets-v2.customall.io")) {
      if (!collected.has(url)) {
        collected.add(url);
      }
    }
  });

  while (true) {
    const selects = await waitUntilStable(page, ".personalized-options select");
    let foundNew = false;

    for (const sel of selects) {
      const selId = await sel.evaluate((el) => el.name || el.id || el.outerHTML);
      if (!changedSelects.has(selId)) {
        changedSelects.add(selId);
        try {
          const options = await sel.$$("option");

          for (let j = 0; j < options.length; j++) {
            const val = await options[j].evaluate((o) => o.value);
            await sel.select(val);
            // ❗ Chờ DOM select ổn định lại sau change
            await waitUntilStable(page, ".personalized-options select");
          }

          foundNew = true;
          break; // BFS: query lại ngay lập tức
        } catch (err) {
          console.log("Skip select element:", err.message);
        }
      }
    }

    if (!foundNew) break;
  }

  while (true) {
    const imgs = await waitUntilStable(page, ".personalized-options img");
    let foundNew = false;
    for (const el of imgs) {
      const handle = await el.evaluate((el) => el.getAttribute("data-id") || el.src);
      if (!clickedImgs.has(handle)) {
        clickedImgs.add(handle);
        try {
          await el.click({ delay: 1000 });
          // ❗ Chờ DOM img ổn định lại sau click
          await waitUntilStable(page, ".personalized-options img");
          foundNew = true;
          break;
        } catch (err) {
          console.log("Skip img click:", err.message);
        }
      }
    }

    if (!foundNew) break;
  }

  await page.waitForNetworkIdle({ idleTime: 2000, timeout: 0 });

  // === 3. Lưu ảnh về folder + nén zip ===
  const uniqueUrls = Array.from(collected);

  let cleanUrl = productUrl.split("?")[0];
  let productHandle =
    new URL(cleanUrl).pathname.split("/products/")[1]?.split("/")[0] || "unknown";
  let newFolder = path.join(newdirname, "downloads", productHandle);
  if (!fs.existsSync(newFolder)) {
    fs.mkdirSync(newFolder, { recursive: true });
  }


  for (let i = 0; i < uniqueUrls.length; i++) {
    const url = uniqueUrls[i];
    try {
      const fileName = path.basename(new URL(url).pathname);
      const filePath = path.join(newFolder, fileName);

      const response = await axios.get(url, { responseType: "stream" });
      const writer = fs.createWriteStream(filePath);

      await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      console.log(`✅ Saved ${fileName}`);
    } catch (err) {
      console.error(`❌ Lỗi tải ${url}:`, err.message);
    }
  }
  
  console.log('chay xong download')
  const zipPath = path.join(newdirname, "downloads", `${productHandle}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      resolve();
    });
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(newFolder, false);
    archive.finalize();
  });


  return { urls: uniqueUrls, folder: newFolder, zipPath };
}


let emailListPath = path.join(__dirname, "emails.json");
if (!fs.existsSync(emailListPath))
  fs.writeFileSync(emailListPath, "[]", "utf-8");

let saveCustomerEmailIfNew = (email) => {
  let existingEmails = JSON.parse(fs.readFileSync(emailListPath, "utf-8"));
  if (!existingEmails.includes(email)) {
    existingEmails.push(email);
    fs.writeFileSync(emailListPath, JSON.stringify(existingEmails, null, 2));
    console.log(`📧 Email mới được lưu: ${email}`);
  } else {
    console.log(`📭 Email đã tồn tại: ${email}`);
  }
};

if (cluster.isMaster) {
  console.log(`✅ Master process ${process.pid} is running`);
  for (let i = 0; i < numCPUs; i++) cluster.fork();
  cluster.on("exit", (worker) => {
    console.log(`⚠️ Worker ${worker.process.pid} died. Spawning a new one...`);
    cluster.fork();
  });
} else {
  let app = express();

  app.use((req, res, next) => {
    req.setTimeout(10 * 60 * 1000);
    res.setTimeout(10 * 60 * 1000);
    next();
  });

  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(express.static("public"));

  app.get("/services", (req, res) => {
    res.sendFile("services.html", { root: "public" });
  });

  // Route to return contact.html
  app.get("/support", (req, res) => {
    res.sendFile("support.html", { root: "public" });
  });

  // Route to return about.html
  app.get("/about", (req, res) => {
    res.sendFile("about.html", { root: "public" });
  });

  app.post("/crawl", async (req, res) => {
    let productUrl = req.body.url;
    let email = req.body.email;
    let cleanUrl = productUrl.split("?")[0];
    let productHandle = new URL(cleanUrl).pathname
      .split("/products/")[1]
      ?.split("/")[0];
    let maxOptions = 1000;
    let downloadDir = path.join(__dirname, "downloads");
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

    saveCustomerEmailIfNew(email);

    let browser;

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    let page = await browser.newPage();

    await retryGoto(page, productUrl);

    setTimeout(() => {
      res.send(
        `<script>alert("⏳ File đang được xử lý. Chúng tôi sẽ gửi email đến ${email} khi hoàn tất."); window.history.back();</script>`
      );
    }, 0);
    
    crawlPersonalizedOptions(page, productUrl, __dirname)
  });

  app.get("/download/:filename", (req, res) => {
    let filename = req.params.filename;
    let filePath = path.join(__dirname, "downloads", filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send("❌ File không tồn tại hoặc đã bị xoá");
    }

    res.download(filePath, (err) => {
      if (err) {
        console.error("❌ Lỗi khi tải file:", err.message);
        return;
      }

      // Sau khi tải thành công thì xoá file
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error(
            `❌ Không thể xoá file ${filename}:`,
            unlinkErr.message
          );
        } else {
          console.log(`🗑 File ${filename} đã được xoá sau khi tải xong`);
        }
      });
    });
  });

  app.listen(PORT, () => {
    console.log(`✅ Worker ${process.pid} is listening on port ${PORT}`);
  });
}
