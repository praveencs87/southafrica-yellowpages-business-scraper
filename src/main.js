import { armKillSwitch, disarmKillSwitch, shouldStop } from './utils/timeoutManager.js';
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const {
        keyword = 'plumber',
        location = 'Cape Town',
        maxLeads = 100,
        proxyConfiguration
    } = input || {};

    // Fyple province/region codes for SA
    const CITY_TO_REGION = {
        'johannesburg': 'gp', 'pretoria': 'gp', 'sandton': 'gp',
        'cape town': 'wc', 'stellenbosch': 'wc', 'paarl': 'wc',
        'durban': 'kzn', 'pietermaritzburg': 'kzn',
        'port elizabeth': 'ec', 'east london': 'ec',
        'bloemfontein': 'fs', 'kimberley': 'nc',
        'nelspruit': 'mp', 'polokwane': 'lp',
    };
    // Default known Fyple category slugs for common keywords
    // Format: keyword (lowercase) → [main-category, sub-category]
    // If no match, use the generic region browse which covers all categories
    const KEYWORD_TO_CATEGORY = {
        'plumber': ['construction-contractor', 'plumber'],
        'plumbing': ['construction-contractor', 'plumber'],
        'electrician': ['construction-contractor', 'electrician'],
        'attorney': ['legal', 'attorney'],
        'lawyer': ['legal', 'attorney'],
        'doctor': ['health-beauty', 'doctor-and-clinic'],
        'clinic': ['health-beauty', 'doctor-and-clinic'],
        'dentist': ['health-beauty', 'dentist'],
        'restaurant': ['food-drink', 'restaurant'],
        'accountant': ['business-service', 'accountant'],
        'school': ['education', 'school'],
        'hotel': ['travel-accommodation', 'hotel'],
        'guesthouse': ['travel-accommodation', 'guest-house'],
        'marketing': ['business-service', 'marketing'],
        'web': ['computer-electronics', 'web'],
        'it': ['computer-electronics', 'it'],
        'builder': ['construction-contractor', 'builder'],
        'carpenter': ['construction-contractor', 'carpenter'],
        'painter': ['construction-contractor', 'painter'],
        'gym': ['sports-recreation', 'gym'],
        'salon': ['health-beauty', 'hair-salon'],
        'pharmacy': ['health-beauty', 'pharmacy'],
    };

    const cityKey = location.toLowerCase().trim();
    const region = CITY_TO_REGION[cityKey] || 'gp';
    const citySlug = encodeURIComponent(cityKey);
    const kwKey = keyword.toLowerCase().trim();
    const category = KEYWORD_TO_CATEGORY[kwKey];

    // Build start URL — category-specific if keyword is known, else generic city browse
    let startUrl;
    if (category) {
        startUrl = `https://www.fyple.co.za/region/${region}/city/${citySlug}/category/${category[0]}/${category[1]}/`;
        log.info(`Using category URL: ${startUrl}`);
    } else {
        // Fallback: browse all businesses in the city, filtered by keyword in the query
        startUrl = `https://www.fyple.co.za/region/${region}/city/${citySlug}/`;
        log.info(`No category mapping for "${keyword}" — browsing all businesses in ${location}`);
    }

    log.info(`Searching Fyple.co.za (South Africa) for "${keyword}" in "${location}"`);

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
                    industry: keyword,
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

    await crawler.addRequests([{ url: startUrl }]);

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
