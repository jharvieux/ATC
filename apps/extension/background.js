// Service worker — registers context menus and relays context menu data
// to submit.html via chrome.storage.session.

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "atc-clip",
    title: "Add to ATC Knowledge Base",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "atc-clip") return;

  const pendingSubmit = {
    selection: info.selectionText ?? "",
    url: info.pageUrl ?? tab?.url ?? "",
    title: tab?.title ?? "",
    capturedAt: Date.now(),
  };

  chrome.storage.session.set({ pendingSubmit }, () => {
    chrome.windows.create({
      url: chrome.runtime.getURL("submit.html"),
      type: "popup",
      width: 500,
      height: 520,
      focused: true,
    });
  });
});
