import { dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import bodyParser from 'body-parser';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import https from 'https';
import archiver from 'archiver';
import cluster from 'cluster';
import os from 'os';
import pLimit from 'p-limit';

const numCPUs = os.cpus().length;
const PORT = 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));

if (cluster.isMaster) {
  console.log(`✅ Master process ${process.pid} is running`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`⚠️ Worker ${worker.process.pid} died. Spawning a new one...`);
    cluster.fork();
  });

} else {
  const app = express();

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
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 0 });

      const shopifyDomain = await page.evaluate(() => {
        try {
          return Shopify?.shop || null;
        } catch (e) {
          return null;
        }
      });

      if (!shopifyDomain) {
        return res.send(`
          <script>
            alert("❌ Không tìm thấy domain Shopify.");
            window.history.back();
          </script>
        `);
      }

      const cleanUrl = productUrl.split('?')[0];
      const handle = new URL(cleanUrl).pathname.split("/products/")[1]?.split("/")[0];
      const productJsUrl = `https://${shopifyDomain}/products/${handle}.js`;
      const productRes = await axios.get(productJsUrl);
      const productData = productRes.data;
      const productId = productData.id;
      const verifiedHandle = productData.handle;

      const customilyUrl = `https://sh.customily.com/api/settings/unified/${verifiedHandle}?shop=${shopifyDomain}&productId=${productId}`;
      const customilyRes = await axios.get(customilyUrl);
      const customilyData = customilyRes.data;

      const swatchValueIds = [];
      customilyData.sets?.forEach(set => {
        const optionset_id = set.optionset_id;
        set.options?.forEach(option => {
          if (option.type === "Swatch") {
            const libraryId = option.libraryId;
            option.values?.forEach(value => {
              swatchValueIds.push({
                optionset_id,
                libraryId,
                value_id: value.id
              });
            });
          }
        });
      });

      const limit = pLimit(10); // 20 concurrent requests
      const elementDataPromises = swatchValueIds.map(item => {
        const libraryId = item.libraryId === 0 ? item.optionset_id : item.libraryId;
        const url = `https://app.customily.com/api/Libraries/${libraryId}/Elements/Position/${item.value_id}`;
        return limit(() => axios.get(url).then(response => ({
          ...item,
          libraryId,
          clipartUrl: response.data.Path.replace('/Content/product-images', 'https://cdn.customily.com/product-images')
        })).catch(err => ({
          ...item,
          libraryId,
          error: err.message
        })));
      });

      const elementDataResults = await Promise.all(elementDataPromises);

      const groupedByLibrary = {};
      elementDataResults.forEach(item => {
        if (!item.clipartUrl || item.error) return;
        const libraryId = item.libraryId;
        if (!groupedByLibrary[libraryId]) groupedByLibrary[libraryId] = [];
        groupedByLibrary[libraryId].push(item.clipartUrl);
      });

      const productFolder = path.join(downloadDir, verifiedHandle);
      if (!fs.existsSync(productFolder)) fs.mkdirSync(productFolder);

      const downloadLimit = pLimit(5); // 10 concurrent downloads per worker

      for (const [libraryId, urls] of Object.entries(groupedByLibrary)) {
        const libraryDir = path.join(productFolder, libraryId);
        if (!fs.existsSync(libraryDir)) fs.mkdirSync(libraryDir);

        await Promise.all(urls.map(url => downloadLimit(async () => {
          const fileName = path.basename(new URL(url).pathname);
          const filePath = path.join(libraryDir, fileName);
          const writer = fs.createWriteStream(filePath);
          const response = await axios.get(url, { responseType: 'stream' });
          await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
        })));
      }

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
      res.send(`
        <script>
          alert("❌ Đã xảy ra lỗi trong quá trình xử lý.\n${error.message}");
          window.history.back();
        </script>
      `);
    } finally {
      if (browser) await browser.close();
    }
  });

  app.listen(PORT, () => {
    console.log(`✅ Worker ${process.pid} is listening on port ${PORT}`);
  });
}
