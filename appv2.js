const puppeteer = require('puppeteer');

async function getShopifyShopVariable(url) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const shopifyDomain = await page.evaluate(() => {
    try {
      return Shopify?.shop || null;
    } catch (e) {
      return null;
    }
  });

  await browser.close();

  return shopifyDomain
}
#4513 