import { dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import bodyParser from 'body-parser';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import cluster from 'cluster';
import os from 'os';
import pLimit from 'p-limit';
import axiosInstance from './utils/axios.js';
import axios from 'axios';
let numCPUs = os.cpus().length;
let PORT = 8080;
let __dirname = dirname(fileURLToPath(import.meta.url));
import nodemailer from 'nodemailer';

let retryGoto = async (page, url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      if (i === retries - 1) throw e;
    }
  }
};

let sendEmailWithDownloadLink = async (productUrl, productTitle, email, downloadUrl) => {
  let transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: 'crawlclipart@gmail.com',
      pass: 'wsxy qyiu gneo crks',
    }
  });

  await transporter.sendMail({
    from: '"Clipart Service" crawlclipart@gmail.com',
    to: email,
    subject: `🎁 File clipart của ${productTitle} đã sẵn sàng`,
    html: `
      <p>Chào bạn,</p>
      <p>File clipart từ link <a href="${productUrl}" target="_blank">${productUrl}</a> của bạn đã được xử lý xong. Bạn có thể tải về tại đường link sau:</p>
      <p><a href="${downloadUrl}" target="_blank">${downloadUrl}</a></p>
      <p style="color: red; font-weight: 600">!!!Lưu ý: Link tải sẽ được xóa sau khi tải xong.</p>
      <p>Trân trọng,<br/>Clipart Service</p>
    `
  });
}

let emailListPath = path.join(__dirname, 'emails.json');
if (!fs.existsSync(emailListPath)) fs.writeFileSync(emailListPath, '[]', 'utf-8');

let saveCustomerEmailIfNew = (email) => {
  let existingEmails = JSON.parse(fs.readFileSync(emailListPath, 'utf-8'));
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
  cluster.on('exit', (worker) => {
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
  app.use(express.static('public'));

  app.post('/crawl', async (req, res) => {
    let productUrl = req.body.url;
    let email = req.body.email;

    let maxOptions = 1000;
    let downloadDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

    saveCustomerEmailIfNew(email);

    let browser;

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let page = await browser.newPage();
    await retryGoto(page, productUrl);

    let shopifyDomain = await page.evaluate(() => {
      for (let i = 0; i < 10; i++) {
        if (typeof Shopify !== 'undefined' && Shopify.shop) {
          return Shopify.shop;
        }
        new Promise(resolve => setTimeout(resolve, 1000));
        console.log('Waiting for Shopify object...');
      }
      return null;
    });

    if (!shopifyDomain) {
      return res.send('<script>alert("❌ Không phải Shopify hoặc Product này không thuộc app customily."); window.history.back();</script>');
    }

    let cleanUrl = productUrl.split('?')[0];
    let handle = new URL(cleanUrl).pathname.split("/products/")[1]?.split("/")[0];
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
      customilyData = customilyRes.data
      detailUrl = `https://app.customily.com/api/Product/GetProduct?productId=${customilyData.productConfig?.initial_product_id}`
      detailResponse = await axiosInstance.get(detailUrl);
      detailData = detailResponse.data;
    } catch (error) {
      return res.send('<script>alert("❌ Product này không thuộc app customily, chúng tôi sẽ update thêm app custom này trong thời gian tới."); window.history.back();</script>')
    }

    setTimeout(() => {
      res.send(`<script>alert("⏳ File đang được xử lý. Chúng tôi sẽ gửi email đến ${email} khi hoàn tất."); window.history.back();</script>`);
    }, 0);

    try {
      let swatchValueIds = detailData?.preview?.imagePlaceHoldersPreview
        ?.map(item => item.imageLibraryId)
        .filter((val, index, self) => val != null && self.indexOf(val) === index);

      let limit = pLimit(10);

      let elementDataPromises = swatchValueIds.flatMap((libraryId) => {
        return Array.from({ length: maxOptions + 1 }, (_, index) =>
          limit(async () => {
            let url = `https://app.customily.com/api/Libraries/${libraryId}/Elements/Position/${index}`;
            console.log('Fetching URL:', url);

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
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      let listClipArt = elementData.filter(item => item !== null).map(item => ({
        ...item,
        Path: item.Path?.replace('/Content', 'https://cdn.customily.com'),
        ThumbnailPath: item.ThumbnailPath?.replace('/Content', 'https://cdn.customily.com'),
      }));

      let validCliparts = listClipArt.filter(item => item?.Path); // hoặc bạn filter kiểu khác
      let groupedByLibrary = {};

      validCliparts.forEach(item => {
        let libraryId = item.Library_LibraryId?.toString();
        let categoryId = item.LibraryCategoryId?.toString();

        if (!groupedByLibrary[libraryId]) groupedByLibrary[libraryId] = {};

        let categoryKey = categoryId || '__no_category__';
        if (!groupedByLibrary[libraryId][categoryKey]) groupedByLibrary[libraryId][categoryKey] = [];

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
          let targetDir = categoryId === '__no_category__'
            ? libraryDir
            : path.join(libraryDir, categoryId);

          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir);

          await Promise.allSettled(cliparts.map(clipart => downloadLimit(async () => {
            let fileName = `${clipart.Name || clipart.ImageId}.png`; // fallback nếu thiếu Name
            let filePath = path.join(targetDir, fileName);
            let writer = fs.createWriteStream(filePath);
            let response = await axiosInstance.get(clipart.Path, { responseType: 'stream' });

            await new Promise((resolve, reject) => {
              response.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
            });
          })));
        }
      }

      // Nén folder thành zip (chạy ngầm sau khi đã res.send)
      let zipPath = path.join(downloadDir, `${verifiedHandle}.zip`);
      let output = fs.createWriteStream(zipPath);
      let archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', async () => {
        // ✅ Gửi email khi file zip đã sẵn sàng
        let downloadUrl = `https://crawlclipart.com/download/${verifiedHandle}.zip`;
        await sendEmailWithDownloadLink(cleanUrl, productTitle, email, downloadUrl);

        // ✅ Xoá thư mục gốc (ảnh) sau khi nén thành công
        fs.rmSync(productFolder, { recursive: true, force: true });
        console.log(`✅ Đã tạo zip và gửi mail link tải tới ${email}`);
      });

      archive.pipe(output);
      archive.directory(productFolder, false);
      archive.finalize();

    } catch (error) {
      console.error('❌ Lỗi:', error);
      res.send(`<script>alert("❌ Đã xảy ra lỗi trong quá trình xử lý. ${error.message}"); window.history.back();</script>`);
    } finally {
      if (browser) await browser.close();
    }
  });

  app.get('/download/:filename', (req, res) => {
    let filename = req.params.filename;
    let filePath = path.join(__dirname, 'downloads', filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('❌ File không tồn tại hoặc đã bị xoá');
    }

    res.download(filePath, (err) => {
      if (err) {
        console.error('❌ Lỗi khi tải file:', err.message);
        return;
      }

      // Sau khi tải thành công thì xoá file
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error(`❌ Không thể xoá file ${filename}:`, unlinkErr.message);
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