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

const retryGoto = async (page, url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      if (i === retries - 1) throw e;
    }
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
    const downloadDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

    let browser;
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

      const maxOptions = customilyData.sets.length ? customilyData.sets.flatMap(item => item.options).reduce((max, item) => {
        return item?.values?.length > max?.values?.length ? item: max
      })?.values?.length : 100

      const detailUrl = `https://app.customily.com/api/Product/GetProduct?productId=${customilyData.productConfig?.initial_product_id}`

      const detailResponse = await axiosInstance.get(detailUrl);
      const detailData = detailResponse.data;

      const swatchValueIds = detailData?.preview?.imagePlaceHoldersPreview
      ?.map(item => item.imageLibraryId)
      .filter(val => val != null);;

      const limit = pLimit(10);

      const elementDataPromises = swatchValueIds.flatMap((item) => {
        return Array.from({ length: maxOptions }, (_, index) => {
          const libraryId = item;
          const url = `https://app.customily.com/api/Libraries/${libraryId}/Elements/Position/${index + 1}`;
          console.log('Fetching URL:', url);
      
          return axios.get(url)
            .then(response => response.data)
            .catch(error => {
              console.error(`❌ Error fetching ${url}`, error.message);
              return null;
            });
        });
      });
      
      const elementData = await Promise.all(elementDataPromises);
      
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
      
      // Nén folder thành zip
      const zipPath = path.join(downloadDir, `${verifiedHandle}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', async () => {
        res.download(zipPath, () => {
          fs.rmSync(productFolder, { recursive: true, force: true });
          fs.unlinkSync(zipPath);
        });
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

  app.listen(PORT, () => {
    console.log(`✅ Worker ${process.pid} is listening on port ${PORT}`);
  });
}