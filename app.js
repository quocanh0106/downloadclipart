const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const archiver = require('archiver');

const app = express();
const PORT = 8080;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.post('/crawl', async (req, res) => {
  const productUrl = req.body.url;
  const downloadDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
  const shopifyDomain = await page.evaluate(() => {
    try {
      return Shopify?.shop || null;
    } catch (e) {
      return null;
    }
  })

  const cleanUrl = productUrl.split('?')[0];
  const handle = new URL(cleanUrl).pathname.split("/products/")[1]?.split("/")[0];
  const productJsUrl = `https://${shopifyDomain}/products/${handle}.js`;
  const productRes = await axios.get(productJsUrl);
  const productData = productRes.data;
  const productId = productData.id;
  const verifiedHandle = productData.handle;

  const customilyUrl = `https://sh.customily.com/api/settings/unified/${verifiedHandle}?shop=${shopifyDomain}&productId=${productId}`;
  console.log(customilyUrl);
  if (!shopifyDomain) {
    res.status(400).send('Shopify domain not found');
    await browser.close();
    return;
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running at http://localhost:${PORT}`);
});
