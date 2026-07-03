import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.brabys.com/');
  console.log(await page.title());
  
  await page.fill('input[name="term"]', 'plumber');
  await page.fill('input[name="town"]', 'Cape Town');
  
  await Promise.all([
    page.waitForNavigation(),
    page.click('button[type="submit"]')
  ]);
  
  console.log('Redirected to:', page.url());
  
  const html = await page.content();
  require('fs').writeFileSync('brabys-search.html', html);
  await page.screenshot({ path: 'brabys-search.png' });
  
  await browser.close();
})();
