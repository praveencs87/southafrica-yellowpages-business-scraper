import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import fs from 'fs';

await Actor.init();

const crawler = new PlaywrightCrawler({
    proxyConfiguration: await Actor.createProxyConfiguration({
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'ZA' // Test ZA
    }),
    requestHandler: async ({ page, request, log }) => {
        log.info(`Scraping: ${request.url}`);
        await page.waitForTimeout(5000);
        const html = await page.content();
        fs.writeFileSync('brabys-dump.html', html);
        await page.screenshot({ path: 'brabys-screenshot.png' });
        log.info('Done Brabys.');
    },
});

await crawler.run(['https://www.brabys.com/search/plumber/cape-town']);

await Actor.exit();
