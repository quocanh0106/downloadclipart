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
      const customilyData = customilyRes.data;

      res.send(customilyData)

      const swatchValueIds = [];
      customilyData.sets?.forEach(set => {
        console.log(set);
        
      });

      // const limit = pLimit(10);
      // const elementDataPromises = swatchValueIds.map(item => {
      //   const libraryId = item.libraryId === 0 ? item.optionset_id : item.libraryId;
      //   const url = `https://app.customily.com/api/Libraries/${libraryId}/Elements/Position/${item.value_id}`;
      //   return limit(() =>
      //     axiosInstance.get(url).then(response => ({
      //       ...item,
      //       libraryId,
      //       clipartUrl: response.data.Path.replace('/Content/product-images', 'https://cdn.customily.com/product-images')
      //     })).catch(err => ({
      //       ...item,
      //       libraryId,
      //       error: err.message
      //     }))
      //   );
      // });

      // const results = await Promise.allSettled(elementDataPromises);
      // const validResults = results
      //   .filter(r => r.status === 'fulfilled' && r.value?.clipartUrl)
      //   .map(r => r.value);

      // const groupedByLibrary = {};
      // validResults.forEach(item => {
      //   const libraryId = item.libraryId;
      //   if (!groupedByLibrary[libraryId]) groupedByLibrary[libraryId] = [];
      //   groupedByLibrary[libraryId].push({ url: item.clipartUrl, value: item.value });
      // });

      // const productFolder = path.join(downloadDir, verifiedHandle);
      // if (!fs.existsSync(productFolder)) fs.mkdirSync(productFolder);

      // const downloadLimit = pLimit(5);

      // for (const [libraryId, urls] of Object.entries(groupedByLibrary)) {
      //   const libraryDir = path.join(productFolder, libraryId);
      //   if (!fs.existsSync(libraryDir)) fs.mkdirSync(libraryDir);

      //   await Promise.allSettled(urls.map(url => downloadLimit(async () => {
      //     const fileName = url.value + '.png';
      //     const filePath = path.join(libraryDir, fileName);
      //     const writer = fs.createWriteStream(filePath);
      //     const response = await axiosInstance.get(url.url, { responseType: 'stream' });
      //     await new Promise((resolve, reject) => {
      //       response.data.pipe(writer);
      //       writer.on('finish', resolve);
      //       writer.on('error', reject);
      //     });
      //   })));
      // }

      // const zipPath = path.join(downloadDir, `${verifiedHandle}.zip`);
      // const output = fs.createWriteStream(zipPath);
      // const archive = archiver('zip', { zlib: { level: 9 } });

      // output.on('close', async () => {
      //   res.download(zipPath, () => {
      //     fs.rmSync(productFolder, { recursive: true, force: true });
      //     fs.unlinkSync(zipPath);
      //   });
      // });

      // archive.pipe(output);
      // archive.directory(productFolder, false);
      // archive.finalize();

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