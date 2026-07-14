import { armKillSwitch, disarmKillSwitch, shouldStop } from './utils/timeoutManager.js';
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const {
        startUrls = [],
        maxLeads = 100,
        proxyConfiguration
    } = input || {};

    log.info(`Searching Fyple.co.za (South Africa)...`);

    // Searching log already above

    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const proxyConfig = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : undefined; // Fyple needs no proxy — plain HTML, no bot protection

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 3,
        maxRequestRetries: 2,
        navigationTimeoutSecs: 30,
        requestHandlerTimeoutSecs: 30,
        additionalMimeTypes: ['text/html'],

        async requestHandler({ $, request, log, enqueueLinks }) {
            if (shouldStop() || extractedCount >= maxLeads) return;
            log.info(`Parsing: ${request.url}`);

            // Fyple listing structure:
            // <li class="mdl-list__item mdl-divider">
            //   <div class="media comp_wrap">
            //     <div class="media-body">
            //       <div class="comp_det">
            //         <a class="comp_title" href="/company/...">Business Name</a>
            //         <div class="comp_adr"><span>icon</span>Address text</div>
            //       </div>
            //     </div>
            //   </div>
            // </li>

            const items = $('li.mdl-list__item.mdl-divider');
            log.info(`Found ${items.length} listings on this page`);

            items.each((_, el) => {
                if (shouldStop() || extractedCount >= maxLeads) return false;

                const item = $(el);
                const titleEl = item.find('a.comp_title');
                const businessName = titleEl.text().trim();
                if (!businessName || businessName.length < 2) return;

                const listingHref = titleEl.attr('href') || '';
                const listingUrl = listingHref.startsWith('http')
                    ? listingHref
                    : `https://www.fyple.co.za${listingHref}`;

                // Address: strip the map-marker icon span text
                const addrEl = item.find('.comp_adr');
                addrEl.find('span').remove(); // remove icon spans
                const address = addrEl.text().replace(/\s+/g, ' ').trim();

                const record = {
                    businessName,
                    industry: '',
                    address,
                    phone: '',     // Available on detail page
                    website: '',   // Available on detail page
                    listingUrl,
                    country: 'South Africa',
                    scrapedAt: new Date().toISOString()
                };

                // Push asynchronously — we'll handle this in a post-loop
                Actor.pushData(record).then(() => {
                    Actor.charge({ eventName: 'lead-extracted', count: 1 });
                });
                extractedCount++;
                log.info(`✅ Extracted: ${businessName} (${extractedCount}/${maxLeads})`);
            });

            // Pagination — Fyple uses /page/N/ suffix
            if (!shouldStop() && extractedCount < maxLeads) {
                const paginationLinks = [];
                $('a[href*="/page/"]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (href && !paginationLinks.includes(href)) paginationLinks.push(href);
                });

                if (paginationLinks.length > 0) {
                    const nextPageHrefs = paginationLinks.map(href =>
                        href.startsWith('http') ? href : `https://www.fyple.co.za${href}`
                    );
                    log.info(`Enqueuing ${nextPageHrefs.length} pagination pages`);
                    await enqueueLinks({ urls: nextPageHrefs });
                }
            }
        },

        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    if (startUrls && startUrls.length > 0) {
        for (const req of startUrls) {
            await crawler.addRequests([{ url: typeof req === 'string' ? req : req.url }]);
        }
    } else {
        log.warning('No startUrls provided. Using default.');
        await crawler.addRequests([{ url: 'https://www.fyple.co.za/search/cape-town/plumber/' }]);
    }

    armKillSwitch(crawler);
    await crawler.run();
    disarmKillSwitch();

    log.info(`🎉 Done! Extracted ${extractedCount} South African business leads from Fyple.co.za.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
