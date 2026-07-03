import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'plumber', 
        location = 'Cape Town', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'ZA'
    });

    log.info(`Searching Brabys.com (South Africa) for "${keyword}" in "${location}"`);
    
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;
    let isSearchSubmitted = false;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing page: ${request.url}`);
            
            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Access Denied') || title.includes('Attention Required') || title.includes('Oh noes!')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }

            // Check if we are on the homepage to submit the search form
            if (request.url === 'https://www.brabys.com/' && !isSearchSubmitted) {
                log.info('Filling out the search form on Brabys homepage...');
                await page.waitForSelector('input[name="term"]');
                await page.fill('input[name="term"]', keyword);
                await page.fill('input[name="town"]', location);
                
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
                    page.click('button[type="submit"]')
                ]);
                
                log.info(`Redirected to search results: ${page.url()}`);
                isSearchSubmitted = true;
            }

            // Now we are on the results page
            await page.waitForSelector('.business-listing, .listing, .result, .card, [itemprop="itemListElement"], .search-result', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM.'));

            // Scroll down to trigger lazy loading
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            const items = await page.$$('.business-listing, .listing, .result, .card, [itemprop="itemListElement"], .search-result');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, .title, .business-name, [itemprop="name"]');
                if (!nameElement) continue;
                const businessName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.address, .location, [itemprop="address"]');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Category
                const catElement = await item.$('.category, .industry, [itemprop="applicationCategory"]');
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
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://www.brabys.com').toString() : listingUrl;

                if (businessName && businessName.length > 1) {
                    const record = {
                        businessName,
                        industry,
                        address,
                        phone,
                        website,
                        listingUrl: fullListingUrl || page.url(),
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
                const hasNextPage = await page.$('.pagination a.next, a[rel="next"]');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://www.brabys.com').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    // Start with the homepage
    await crawler.addRequests([{
        url: 'https://www.brabys.com/'
    }]);

    await crawler.run();

    log.info(`🎉 Done! Extracted ${extractedCount} South African Business leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
