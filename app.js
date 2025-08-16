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
import nodemailer from "nodemailer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const numCPUs = os.cpus().length;
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || "http://localhost:3000";

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
          <img src="${DOMAIN}/logo.png" alt="Clipart Service Logo" style="width:150px;height:auto;margin-bottom:15px;">
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
const isPrimary = cluster.isPrimary ?? cluster.isMaster;
if (isPrimary) {
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

    let shopifyDomain = await page.evaluate(() => {
      try {
        return Shopify.shop;
      } catch {
        return null;
      }
    });

    if (!shopifyDomain && productUrl.includes("pawfecthouse.com")) {
      shopifyDomain = "thepawfecthouse.myshopify.com";
    }

    if (!shopifyDomain) {
      return res.send(
        '<script>alert("❌ Không phải Shopify hoặc Product này không thuộc app customily."); window.history.back();</script>'
      );
    }

    let cleanUrl = productUrl.split("?")[0];
    let handle = new URL(cleanUrl).pathname
      .split("/products/")[1]
      ?.split("/")[0];
    let productJsUrl = `https://${shopifyDomain}/products/${handle}.js`;

    let productRes = await axiosInstance.get(productJsUrl);
    let productData = productRes.data;
    let productId = productData.id;
    let productTitle = productData.title;
    let verifiedHandle = productData.handle;

    let customilyUrl = `https://sh.customily.com/api/settings/unified/${verifiedHandle}?shop=${shopifyDomain}&productId=${productId}`;
    let customilyRes, customilyData, detailUrl, detailResponse, detailData;

    try {
      customilyRes = await axiosInstance.get(customilyUrl);
      customilyData = customilyRes.data;
      detailUrl = `https://app.customily.com/api/Product/GetProduct?productId=${customilyData.productConfig?.initial_product_id}`;
      detailResponse = await axiosInstance.get(detailUrl);
      detailData = detailResponse.data;
    } catch (error) {
      return res.send(
        '<script>alert("❌ Product này không thuộc app customily, chúng tôi sẽ update thêm app custom này trong thời gian tới."); window.history.back();</script>'
      );
    }

    setTimeout(() => {
      res.send(
        `<script>alert("⏳ File đang được xử lý. Chúng tôi sẽ gửi email đến ${email} khi hoàn tất."); window.history.back();</script>`
      );
    }, 0);

    let dynamicImagesPath = []

    try {
      let swatchValueIds = detailData?.preview?.imagePlaceHoldersPreview
        ?.map((item) => {
          if (item?.imageLibraryId) {
            return item.imageLibraryId;
          } else {
            dynamicImagesPath.push({folder: item.id, images: item?.dynamicImagesPath})
            return null;
          }
        })
        .filter(
          (val, index, self) => val != null && self.indexOf(val) === index
        );

      let limit = pLimit(10);

      let elementDataPromises = swatchValueIds.flatMap((libraryId) => {
        return Array.from({ length: maxOptions + 1 }, (_, index) =>
          limit(async () => {
            let url = `https://app.customily.com/api/Libraries/${libraryId}/Elements/Position/${index}`;
            console.log("Fetching URL:", url);

            try {
              let response = await axios.get(url);
              return response.data;
            } catch (error) {
              console.error(`❌ Error fetching ${url}`, error.message);
              return null;
            }
          })
        );
      });

      let settledResults = await Promise.allSettled(elementDataPromises);
      let elementData = settledResults
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value);

      let listClipArt = elementData
        .filter((item) => item !== null)
        .map((item) => ({
          ...item,
          Path: item.Path?.replace("/Content", "https://cdn.customily.com"),
          ThumbnailPath: item.ThumbnailPath?.replace(
            "/Content",
            "https://cdn.customily.com"
          ),
        }));

      dynamicImagesPath.forEach((item) => {
        let allImages = JSON.parse(item.images).map((img) => {
          return {
            Library_LibraryId: item.folder,
            LibraryCategoryId: null,
            Name: img[1].split("/").pop().split(".")[0],
            Path: img[1].replace("/Content", "https://cdn.customily.com"),
            ThumbnailPath: img[1].replace("/Content", "https://cdn.customily.com"),
          }
        })
        listClipArt.push(...allImages)
      })

      let validCliparts = listClipArt.filter((item) => item?.Path); // hoặc bạn filter kiểu khác
      let groupedByLibrary = {};

      validCliparts.forEach((item) => {
        let libraryId = item.Library_LibraryId?.toString();
        let categoryId = item.LibraryCategoryId?.toString();

        if (!groupedByLibrary[libraryId]) groupedByLibrary[libraryId] = {};

        let categoryKey = categoryId || "__no_category__";
        if (!groupedByLibrary[libraryId][categoryKey])
          groupedByLibrary[libraryId][categoryKey] = [];

        groupedByLibrary[libraryId][categoryKey].push(item);
      });

      let productFolder = path.join(downloadDir, verifiedHandle);
      if (!fs.existsSync(productFolder)) fs.mkdirSync(productFolder);

      let downloadLimit = pLimit(5);

      // Tải từng ảnh theo thư mục LibraryId / CategoryId
      for (let [libraryId, categories] of Object.entries(groupedByLibrary)) {
        let libraryDir = path.join(productFolder, libraryId);
        if (!fs.existsSync(libraryDir)) fs.mkdirSync(libraryDir);

        for (let [categoryId, cliparts] of Object.entries(categories)) {
          let targetDir =
            categoryId === "__no_category__"
              ? libraryDir
              : path.join(libraryDir, categoryId);

          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir);

          await Promise.allSettled(
            cliparts.map((clipart) =>
              downloadLimit(async () => {
                let fileName = `${clipart.Name || clipart.ImageId}.png`; // fallback nếu thiếu Name
                let filePath = path.join(targetDir, fileName);
                let writer = fs.createWriteStream(filePath);
                let response = await axiosInstance.get(clipart.Path, {
                  responseType: "stream",
                });

                await new Promise((resolve, reject) => {
                  response.data.pipe(writer);
                  writer.on("finish", resolve);
                  writer.on("error", reject);
                });
              })
            )
          );
        }
      }

      // Nén folder thành zip (chạy ngầm sau khi đã res.send)
      let zipPath = path.join(downloadDir, `${verifiedHandle}.zip`);
      let output = fs.createWriteStream(zipPath);
      let archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", async () => {
        // ✅ Gửi email khi file zip đã sẵn sàng
        let downloadUrl = `${process.env.DOMAIN}/download/${verifiedHandle}.zip`;
        await sendEmailWithDownloadLink(
          cleanUrl,
          productTitle,
          email,
          downloadUrl
        );

        // ✅ Xoá thư mục gốc (ảnh) sau khi nén thành công
        fs.rmSync(productFolder, { recursive: true, force: true });
        console.log(`✅ Đã tạo zip và gửi mail link tải tới ${email}`);
      });

      archive.pipe(output);
      archive.directory(productFolder, false);
      archive.finalize();
    } catch (error) {
      console.error("❌ Lỗi:", error);
      res.send(
        `<script>alert("❌ Đã xảy ra lỗi trong quá trình xử lý. ${error.message}"); window.history.back();</script>`
      );
    } finally {
      if (browser) await browser.close();
    }
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
