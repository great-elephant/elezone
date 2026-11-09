// Each tab gets its own side panel instance; the tab id travels in the page
// URL because a panel page has no other way to learn which tab it belongs to.
export const SIDE_PANEL_PATH = 'src/sidepanel/index.html'

// Must run inside a user-gesture handler (click or command): chrome.sidePanel.open
// rejects otherwise. open() must be the first call after the gesture, so
// setOptions is not awaited; the browser applies the calls in order.
export function openStudyPanel(tabId: number): Promise<void> {
  chrome.sidePanel
    .setOptions({
      tabId,
      path: `${SIDE_PANEL_PATH}?tabId=${tabId}`,
      enabled: true,
    })
    .catch(err => console.warn('EleZone: sidePanel.setOptions failed', err))
  return chrome.sidePanel.open({ tabId })
}
