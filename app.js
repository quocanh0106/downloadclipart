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
const numCPUs = os.cpus().length;
const PORT = 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));
import nodemailer from 'nodemailer';

const retryGoto = async (page, url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      if (i === retries - 1) throw e;
    }
  }
};

const sendEmailWithDownloadLink = async (email, downloadUrl) => {
  const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: 'crawlclipart@gmail.com',
      pass: 'wsxy qyiu gneo crks',
    }
  });

  await transporter.sendMail({
    from: '"Clipart Service" crawlclipart@gmail.com',
    to: email,
    subject: '🎁 File clipart của bạn đã sẵn sàng',
    html: `
      <p>Chào bạn,</p>
      <p>File clipart của bạn đã được xử lý xong. Bạn có thể tải về tại đường link sau:</p>
      <p><a href="${downloadUrl}">${downloadUrl}</a></p>
      <p>Lưu ý: Link tải sẽ được xóa sau khi tải xong.</p>
      <p>Nếu bạn không yêu cầu file này, vui lòng bỏ qua email này.</p>
      <p>Trân trọng,<br/>Clipart Service</p>
    `
  });
}

const emailListPath = path.join(__dirname, 'emails.json');
if (!fs.existsSync(emailListPath)) fs.writeFileSync(emailListPath, '[]', 'utf-8');

const saveCustomerEmailIfNew = (email) => {
  const existingEmails = JSON.parse(fs.readFileSync(emailListPath, 'utf-8'));
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
  const app = express();

  app.use((req, res, next) => {
    req.setTimeout(10 * 60 * 1000);
    res.setTimeout(10 * 60 * 1000);
    next();
  });

  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(express.static('public'));

  app.post('/crawl', async (req, res) => {
    const productUrl = req.body.url;
    const email = req.body.email;

    const maxOptions = 1000;
    const downloadDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

    let browser;

    setTimeout(() => {
      res.send(`<script>alert("⏳ File đang được xử lý. Chúng tôi sẽ gửi email đến ${email} khi hoàn tất."); window.history.back();</script>`);
    }, 3000);
    saveCustomerEmailIfNew(email);

    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      await retryGoto(page, productUrl);

      const shopifyDomain = await page.evaluate(() => {
        try {
          return Shopify?.shop || null;
        } catch {
          return null;
        }
      });

      if (!shopifyDomain) {
        return res.send('<script>alert("❌ Không tìm thấy domain Shopify."); window.history.back();</script>');
      }

      const cleanUrl = productUrl.split('?')[0];
      const handle = new URL(cleanUrl).pathname.split("/products/")[1]?.split("/")[0];
      const productJsUrl = `https://${shopifyDomain}/products/${handle}.js`;

      const productRes = await axiosInstance.get(productJsUrl);
      const productData = productRes.data;
      const productId = productData.id;
      const verifiedHandle = productData.handle;

      const customilyUrl = `https://sh.customily.com/api/settings/unified/${verifiedHandle}?shop=${shopifyDomain}&productId=${productId}`;
      const customilyRes = await axiosInstance.get(customilyUrl);
      const customilyData = customilyRes.data

      const detailUrl = `https://app.customily.com/api/Product/GetProduct?productId=${customilyData.productConfig?.initial_product_id}`

      const detailResponse = await axiosInstance.get(detailUrl);
      const detailData = detailResponse.data;

      const swatchValueIds = detailData?.preview?.imagePlaceHoldersPreview
        ?.map(item => item.imageLibraryId)
        .filter((val, index, self) => val != null && self.indexOf(val) === index);

      const limit = pLimit(10);

      const elementDataPromises = swatchValueIds.flatMap((libraryId) => {
        return Array.from({ length: maxOptions + 1 }, (_, index) =>
          limit(async () => {
            const url = `https://app.customily.com/api/Libraries/${libraryId}/Elements/Position/${index}`;
            console.log('Fetching URL:', url);

            try {
              const response = await axios.get(url);
              return response.data;
            } catch (error) {
              console.error(`❌ Error fetching ${url}`, error.message);
              return null;
            }
          })
        );
      });

      const settledResults = await Promise.allSettled(elementDataPromises);
      const elementData = settledResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      const listClipArt = elementData.filter(item => item !== null).map(item => ({
        ...item,
        Path: item.Path?.replace('/Content', 'https://cdn.customily.com'),
        ThumbnailPath: item.ThumbnailPath?.replace('/Content', 'https://cdn.customily.com'),
      }));

      const validCliparts = listClipArt.filter(item => item?.Path); // hoặc bạn filter kiểu khác
      const groupedByLibrary = {};

      validCliparts.forEach(item => {
        const libraryId = item.Library_LibraryId?.toString();
        const categoryId = item.LibraryCategoryId?.toString();

        if (!groupedByLibrary[libraryId]) groupedByLibrary[libraryId] = {};

        const categoryKey = categoryId || '__no_category__';
        if (!groupedByLibrary[libraryId][categoryKey]) groupedByLibrary[libraryId][categoryKey] = [];

        groupedByLibrary[libraryId][categoryKey].push(item);
      });

      const productFolder = path.join(downloadDir, verifiedHandle);
      if (!fs.existsSync(productFolder)) fs.mkdirSync(productFolder);

      const downloadLimit = pLimit(5);

      // Tải từng ảnh theo thư mục LibraryId / CategoryId
      for (const [libraryId, categories] of Object.entries(groupedByLibrary)) {
        const libraryDir = path.join(productFolder, libraryId);
        if (!fs.existsSync(libraryDir)) fs.mkdirSync(libraryDir);

        for (const [categoryId, cliparts] of Object.entries(categories)) {
          const targetDir = categoryId === '__no_category__'
            ? libraryDir
            : path.join(libraryDir, categoryId);

          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir);

          await Promise.allSettled(cliparts.map(clipart => downloadLimit(async () => {
            const fileName = `${clipart.Name || clipart.ImageId}.png`; // fallback nếu thiếu Name
            const filePath = path.join(targetDir, fileName);
            const writer = fs.createWriteStream(filePath);
            const response = await axiosInstance.get(clipart.Path, { responseType: 'stream' });

            await new Promise((resolve, reject) => {
              response.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
            });
          })));
        }
      }

      // Nén folder thành zip (chạy ngầm sau khi đã res.send)
      const zipPath = path.join(downloadDir, `${verifiedHandle}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', async () => {
        // ✅ Gửi email khi file zip đã sẵn sàng
        const downloadUrl = `http://crawlclipart.com/download/${verifiedHandle}.zip`;
        await sendEmailWithDownloadLink(email, downloadUrl);

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
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'downloads', filename);

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