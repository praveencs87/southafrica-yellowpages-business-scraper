import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'plumber', 
        location = 'Johannesburg', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'ZA'
    });

    log.info(`Searching YellowPages.co.za for "${keyword}" in "${location}"`);
    
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            // Accept cookies if presented
            await page.locator('#accept-cookies, .cookie-accept, button:has-text("Accept")').click({ timeout: 5000 }).catch(() => {});
            
            await page.waitForSelector('.search-result-item, .listing, .result, .business-card, [data-testid="listing"]', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM.'));

            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Access Denied') || title.includes('Attention Required')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }

            // Scroll down to trigger lazy loading
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            const items = await page.$$('.search-result-item, .listing, .result, .business-card, [data-testid="listing"]');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, .title, .business-name, h3');
                if (!nameElement) continue;
                const businessName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.address, .location, [itemprop="address"]');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Category
                const catElement = await item.$('.category, .industry, .sub-title');
                const industry = catElement ? (await catElement.innerText()).trim() : keyword;

                // Phones
                const phoneElement = await item.$('a[href^="tel:"], .phone, .contact-number, [itemprop="telephone"]');
                let phone = '';
                if (phoneElement) {
                    const href = await phoneElement.getAttribute('href');
                    if (href && href.startsWith('tel:')) {
                        phone = href.replace('tel:', '').trim();
                    } else {
                        phone = (await phoneElement.innerText()).trim();
                    }
                }
                
                // Website
                const websiteElement = await item.$('.website a, a.website-link, a[itemprop="url"]');
                const website = websiteElement ? await websiteElement.getAttribute('href') : '';
                
                // URL
                const urlElement = await item.$('h2 a, .business-name a, a.title');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://www.yellowpages.co.za').toString() : listingUrl;

                if (businessName && businessName.length > 1) {
                    const record = {
                        businessName,
                        industry,
                        address,
                        phone,
                        website,
                        listingUrl: fullListingUrl || request.url,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${businessName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('.pagination a.next, a.next-page, a:has-text("Next"), a[rel="next"]');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://www.yellowpages.co.za').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                } else {
                     // Try synthetic pagination
                    const currentUrl = new URL(request.url);
                    let pageNum = 1;
                    if (currentUrl.searchParams.has('page')) {
                        pageNum = parseInt(currentUrl.searchParams.get('page'));
                        currentUrl.searchParams.set('page', (pageNum + 1).toString());
                    } else if (currentUrl.searchParams.has('p')) {
                        pageNum = parseInt(currentUrl.searchParams.get('p'));
                        currentUrl.searchParams.set('p', (pageNum + 1).toString());
                    } else {
                        currentUrl.searchParams.set('page', '2');
                    }
                    
                    if(pageNum < 10) { 
                        log.info(`Attempting synthetic pagination to: ${currentUrl.toString()}`);
                        await enqueueLinks({
                            urls: [currentUrl.toString()],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const formatKeyword = encodeURIComponent(keyword);
    const formatLocation = encodeURIComponent(location);
    // Generic ZA Search URL structure
    const startUrl = `https://www.yellowpages.co.za/search?what=${formatKeyword}&where=${formatLocation}`;
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    await crawler.run();

    log.info(`🎉 Done! Extracted ${extractedCount} South African Business leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
