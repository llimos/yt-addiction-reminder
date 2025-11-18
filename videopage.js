function extractVarFromHtml(html, varName) {
    const regex = new RegExp(`var ${varName} = (.*?);(var|</script>)`);
    const match = html.match(regex);
    return match ? JSON.parse(match[1]) : null;
}

function getYtPageData(page) {
    return fetch(page)
        .then(response => response.text())
        .then(html => {
            const ytInitialDataMatch = extractVarFromHtml(html, "ytInitialData");
            if (ytInitialDataMatch) {
                return ytInitialDataMatch;
            } else {
                throw new Error("ytInitialData not found");
            }
        });
}

function getYtHistory() {
    return getYtPageData('/feed/history')
        .then(data => {
            const historyItems = [];
            const contents = data.contents.twoColumnBrowseResultsRenderer.tabs[0]
                .tabRenderer.content.sectionListRenderer.contents;
            // 0 is today, 1 is yesterday, etc.
            // May not exist if no history that day
            // We are only interested in today and yesterday
            let today, yesterday;
            for (let i = 0; i < 2; i++) {
                if (contents[i].itemSectionRenderer.header.itemSectionHeaderRenderer.title.runs[0].text === "Today") {
                    today = contents[i].itemSectionRenderer.contents;
                } else if (contents[i].itemSectionRenderer.header.itemSectionHeaderRenderer.title.runs[0].text === "Yesterday") {
                    yesterday = contents[i].itemSectionRenderer.contents;
                }
            }
            return { today, yesterday };
        });
}

async function parseHistoryDayContents(historyItems) {
    const parsedItems = [];
    const shortsMap = {};
    for (const item of historyItems) {
        if (item.reelShelfRenderer) {
            // Shorts
            for (const shortItem of item.reelShelfRenderer.items) {
                const id = shortItem.shortsLockupViewModel.onTap.innertubeCommand.reelWatchEndpoint.videoId;
                const durationKey = `duration-${id}`;
                const data = {
                    title: shortItem.shortsLockupViewModel.overlayMetadata.primaryText.content,
                    thumbnail: shortItem.shortsLockupViewModel.thumbnail.sources[0],
                    isShort: true,
                    duration_seconds: 60
                }
                parsedItems.push(data);
                shortsMap[durationKey] = data;
            }
        } else if (item.lockupViewModel) {
            // Regular video
            const durationText = item.lockupViewModel.contentImage.thumbnailViewModel.overlays[0].thumbnailBottomOverlayViewModel.badges[0].thumbnailBadgeViewModel.text;
            const [seconds, minutes, hours] = durationText.split(':').map(Number).reverse();
            const duration_seconds = (hours || 0) * 3600 + (minutes || 0) * 60 + (seconds || 0);

            const progress = item.lockupViewModel.contentImage.thumbnailViewModel.overlays[0].thumbnailBottomOverlayViewModel.progressBar.thumbnailOverlayProgressBarViewModel.startPercent;
            const watched_seconds = Math.round(duration_seconds * (progress / 100));

            parsedItems.push({
                title: item.lockupViewModel.metadata.lockupMetadataViewModel.title.content,
                thumbnail: item.lockupViewModel.contentImage.thumbnailViewModel.image.sources[0],
                isShort: false,
                duration_seconds: watched_seconds
            });
        }
    }

    // Now fill in durations for shorts from storage
    const keys = Object.keys(shortsMap);
    const storedDurations = await browser.storage.local.get(keys);
    for (const key of keys) {
        if (storedDurations[key]) {
            shortsMap[key].duration_seconds = storedDurations[key];
        }
    }
    return parsedItems;
}

function getViewData() {
    return getYtHistory().then(async ({ today, yesterday }) => {
        const todayItems = today ? await parseHistoryDayContents(today) : [];
        const yesterdayItems = yesterday ? await parseHistoryDayContents(yesterday) : [];
        return { today: todayItems, yesterday: yesterdayItems };
    });
}

async function renderVideoPage() {
    // Clear it if it's already there (YT keeps it cached but we want to refresh it)
    const existingContainer = document.getElementById('yt-addiction-reminder-container');
    if (existingContainer) {
        existingContainer.remove();
    }
    if (window.location.pathname === '/watch') {
        onWatchSidebarReady(renderInto);
    } else if (window.location.pathname.startsWith('/shorts')) {
        // Save the current video's duration to storage after loading
        setTimeout(() => {
            const videoId = window.location.pathname.split('/')[2];
            const duration = document.querySelector('ytd-shorts ytd-player video')?.duration;
            if (duration) {
                browser.storage.local.set({[`duration-${videoId}`]: Math.round(duration)});
            }
        }, 4000);

        const container = document.createElement('div');
        container.style.width = "33%";
        container.style.position = 'absolute';
        container.style.right = 0;
        container.style.top = 0;
        document.getElementById('shorts-panel-container').appendChild(container);
        renderInto(container);
    }
}

async function renderInto(hostElement) {
    const viewData = await getViewData();
    if (viewData.today.length || viewData.yesterday.length) {
        // Render the list at the top of the sidebar
        const container = document.createElement('div');
        container.id = 'yt-addiction-reminder-container';
        container.style.marginBottom = '16px';
        hostElement.prepend(container);
        const mergeDays = new Date().getHours() < 5; // Merge yesterday into today if before 5am
        const header = document.createElement('h2');
        header.textContent = 'Already Watched Today';
        container.appendChild(header);
        
        let durationSeconds = 0;
        let videoCount = 0;
        let shortsCount = 0;
        for (const item of [...viewData.today, ...viewData.yesterday]) {
            durationSeconds += item.duration_seconds;
            if (item.isShort) {
                shortsCount += 1;
            } else {
                videoCount += 1;
            }
        }

        const durationFormatted = formatDuration(durationSeconds);
        const durationSuffix = durationSeconds >= 3600 ? ' hours' : durationSeconds >= 60 ? ' minutes' : ' seconds';

        const summary = document.createElement('h3');
        summary.textContent = `${videoCount} videos, ${shortsCount} shorts. Total ${durationFormatted}${durationSuffix}.`;
        container.appendChild(summary);
        const list = document.createElement('ul');
        list.style.listStyleType = 'none';
        list.style.padding = '0';
        container.appendChild(list);
        for (const item of viewData.today) {
            list.appendChild(renderItem(item));
        }
        let yesterdayList = list;
        if (!mergeDays && viewData.yesterday.length) {
            const yesterdayHeader = document.createElement('h2');
            yesterdayHeader.textContent = 'Yesterday';
            container.appendChild(yesterdayHeader);
            yesterdayList = document.createElement('ul');
            yesterdayList.style.listStyleType = 'none';
            yesterdayList.style.padding = '0';
            container.appendChild(yesterdayList);
        }
        for (const item of viewData.yesterday) {
            yesterdayList.appendChild(renderItem(item));
        }
    }
}

function renderItem(item) {
    const listItem = document.createElement('li');
    listItem.style.display = 'flex';
    listItem.style.alignItems = 'center';
    listItem.style.marginBottom = '8px';
    const thumbnail = document.createElement('img');
    thumbnail.src = item.thumbnail.url;
    // Scale thumbnail to 72px height
    const scale = 72 / item.thumbnail.height;
    thumbnail.style.width = item.thumbnail.width * scale + 'px';
    thumbnail.style.height = item.thumbnail.height * scale + 'px';
    thumbnail.style.marginRight = '8px';
    listItem.appendChild(thumbnail);
    const titleContainer = document.createElement('div');
    const title = document.createElement('p');
    title.textContent = item.title;
    const duration = document.createElement('p');
    duration.textContent = item.isShort && item.duration_seconds === 60 ? 'Short' : formatDuration(item.duration_seconds);
    duration.style.color = 'gray';
    titleContainer.appendChild(duration);
    titleContainer.appendChild(title);
    listItem.appendChild(titleContainer);
    return listItem;
}

function formatDuration(seconds) {
    const hoursWatched = seconds > 3600 ? Math.floor(seconds / 3600).toString() + ':' : '';
    const minutesWatched = Math.floor((seconds % 3600) / 60).toString().padStart(seconds > 3600 ? 2 : 1, '0') + ':';
    const secondsWatched = (seconds % 60).toString().padStart(2, '0');
    return `${hoursWatched}${minutesWatched}${secondsWatched}`;
}

function onWatchSidebarReady(cb) {
    const page = document.querySelector('ytd-app ytd-page-manager');
    if (!page) 
        throw new Error('ytd-page-manager not found');

    const existing = page.querySelector('#secondary-inner');
    if (existing) 
        return cb(existing);          // already loaded

    let disconnected = false;
    new MutationObserver((changes, observer) => {
        const el = page.querySelector('#secondary');
        if (!disconnected && el) {
            disconnected = true;
            observer.disconnect();
            cb(el);
        }
    }).observe(page, { childList: true, subtree: true });
}

document.addEventListener('yt-navigate-finish', renderVideoPage);