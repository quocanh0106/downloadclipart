const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const archiver = require('archiver');

const app = express();
const PORT = 5000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.post('/crawl', async (req, res) => {
  const productUrl = req.body.url;
  const downloadDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(productUrl, { waitUntil: 'load' });

    // 📸 Theo dõi request mạng thay vì DOM để bắt ảnh thực
    const capturedImages = new Set();
    page.on('requestfinished', async (req) => {
      try {
        const res = req.response();
        const url = req.url();
        const contentType = res.headers()['content-type'] || '';
        if (
          contentType.startsWith('image/') &&
          url.includes('customily') &&
          !url.includes('thumbnail')
        ) {
          capturedImages.add(url.split('?')[0]);
        }
      } catch (e) {}
    });

    // 🔁 Auto chọn tất cả các select/radio theo thứ tự
    await page.evaluate(async () => {
      function wait(ms) {
        return new Promise(res => setTimeout(res, ms));
      }

      let handledSelects = new Set();
      while (true) {
        const selects = Array.from(document.querySelectorAll('select')).filter(s => !handledSelects.has(s));
        if (selects.length === 0) break;
        for (const select of selects) {
          const lastOption = select.options[select.options.length - 1];
          if (lastOption) {
            select.value = lastOption.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            handledSelects.add(select);
            await wait(1000);
          }
        }
      }

      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const radio of radios) {
        if (!radio.checked) {
          radio.click();
          await wait(500);
        }
      }
    });

    // Đợi Customily render ảnh sau khi chọn hết
    await new Promise(resolve => setTimeout(resolve, 5000));

    const imageUrls = Array.from(capturedImages);

    // 📦 Thêm ảnh từ customilyFieldsData nếu có
    const extraCustomilyUrls = await page.evaluate(() => {
      const result = new Set();
      try {
        const isValid = (val) => typeof val === 'string' && val.startsWith('http') && !val.includes('thumbnail');
        const collectUrls = (obj) => {
          for (const key in obj) {
            if (typeof obj[key] === 'string' && isValid(obj[key])) {
              result.add(obj[key]);
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
              collectUrls(obj[key]);
            }
          }
        };
        if (window.customilyFieldsData) {
          collectUrls(window.customilyFieldsData);
        }
      } catch (e) {}
      return Array.from(result);
    });

    // Lấy title làm tên thư mục
    const title = await page.title();
    const safeTitle = title.replace(/[<>:"/\\|?*]+/g, '_');
    const imgDir = path.join(downloadDir, safeTitle);
    const zipPath = path.join(downloadDir, `${safeTitle}.zip`);
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir);

    const finalImageUrls = Array.from(new Set([...imageUrls, ...extraCustomilyUrls]));
    console.log(`📸 Tổng ảnh cần tải: ${finalImageUrls.length}`);

    // 📥 Tải ảnh về
    for (const url of finalImageUrls) {
      const fileName = path.basename(url.split('?')[0]);
      const filePath = path.join(imgDir, fileName);
      const file = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        https.get(url, response => {
          response.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', reject);
      });
    }

    // 📦 Nén thành ZIP
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(imgDir, false);
    await archive.finalize();

    await browser.close();
    res.download(zipPath);
  } catch (err) {
    console.error(err);
    res.status(500).send('Lỗi khi crawl ảnh.');
    await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running at http://localhost:${PORT}`);
});
