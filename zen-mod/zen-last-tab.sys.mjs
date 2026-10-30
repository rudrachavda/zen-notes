// ==UserScript==
// @name           Last tab in ⌘T
// @description    Puts your last used tab at the top of the ⌘T bar, so ⌘T then Enter switches back to it.
// @version        1.0.0
// ==/UserScript==

// Loaded once by fx-autoconfig (a .sys.mjs in chrome/JS is a background module).
// Adds a URL bar provider that, while the bar is empty and opened with ⌘T, offers
// the most recently used tab (in any space) as the preselected result.

import { ProvidersManager } from "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs";
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

const PROVIDER_NAME = "ZenLastTabProvider";
const DYNAMIC_TYPE_NAME = "zen-last-tab";
const DEFAULT_ICON = "chrome://global/skin/icons/defaultFavicon.svg";
// Off switch in about:config.
const ENABLED_PREF = "zen.urlbar.last-tab.enabled";
// false (default): only when the bar was opened with ⌘T. true: also when you
// click into an empty URL bar.
const EVERYWHERE_PREF = "zen.urlbar.last-tab.everywhere";
// true: only look at tabs in the space you're in.
const CURRENT_SPACE_PREF = "zen.urlbar.last-tab.current-space-only";

// --- Finding the tab ------------------------------------------------------------

function lastUsedTab(win) {
  const { gBrowser, gZenWorkspaces } = win;
  const space = Services.prefs.getBoolPref(CURRENT_SPACE_PREF, false)
    ? gZenWorkspaces?.activeWorkspace
    : null;
  let best = null;
  for (const tab of gBrowser.tabs) {
    if (
      tab == gBrowser.selectedTab ||
      tab.closing ||
      tab.hasAttribute("zen-empty-tab") ||
      tab.hasAttribute("zen-glance-tab") ||
      // Essentials belong to every space.
      (space &&
        !tab.hasAttribute("zen-essential") &&
        tab.getAttribute("zen-workspace-id") != space)
    ) {
      continue;
    }
    if (!best || tab.lastAccessed > best.lastAccessed) {
      best = tab;
    }
  }
  return best;
}

// The tab's space name when it isn't the one you're in, shown on the row.
function spaceName(win, tab) {
  const workspaces = win.gZenWorkspaces;
  const id = tab.getAttribute("zen-workspace-id");
  if (!workspaces || !id || tab.hasAttribute("zen-essential") || id == workspaces.activeWorkspace) {
    return "";
  }
  return workspaces.getWorkspaceFromId?.(id)?.name || "";
}

// --- Provider -------------------------------------------------------------------

class ZenLastTabProvider extends UrlbarProvider {
  get name() {
    return PROVIDER_NAME;
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  // Top Sites, which fills the empty bar, has priority 1 and hides every
  // provider below it, so match it.
  getPriority() {
    return 1;
  }

  async isActive(queryContext) {
    if (
      queryContext.searchString ||
      queryContext.searchMode ||
      queryContext.sapName != "urlbar" ||
      !Services.prefs.getBoolPref(ENABLED_PREF, true)
    ) {
      return false;
    }
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (!win?.gBrowser) {
      return false;
    }
    return (
      win.gURLBar.hasAttribute("zen-newtab") ||
      Services.prefs.getBoolPref(EVERYWHERE_PREF, false)
    );
  }

  async startQuery(queryContext, addCallback) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const tab = win && lastUsedTab(win);
    if (!tab) {
      return;
    }
    addCallback(
      this,
      new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: UrlbarShared.RESULT_SOURCE.TABS,
        // Heuristic so the view preselects it and Enter picks it. The group is
        // what the muxer would pick anyway; naming it skips a console warning.
        heuristic: true,
        group: UrlbarShared.RESULT_GROUP.HEURISTIC_FALLBACK,
        payload: {
          dynamicType: DYNAMIC_TYPE_NAME,
          // Results cross to the view as data, so point at the tab by its panel id.
          zenLastTabPanel: tab.linkedPanel,
          title: tab.label || tab.linkedBrowser?.currentURI?.spec || "",
          icon: tab.getAttribute("image") || DEFAULT_ICON,
          space: spaceName(win, tab),
        },
      })
    );
  }

  getViewUpdate(result) {
    return {
      icon: { attributes: { src: result.payload.icon } },
      title: { textContent: result.payload.title, attributes: { dir: "auto" } },
      space: {
        textContent: result.payload.space,
        attributes: { dir: "auto", hidden: !result.payload.space },
      },
      action: { l10n: { id: "urlbar-result-action-switch-tab" } },
    };
  }

  getViewTemplate() {
    return {
      attributes: {
        selectable: true,
      },
      children: [
        {
          name: "icon",
          tag: "img",
          classList: ["urlbarView-favicon"],
        },
        {
          name: "title",
          tag: "span",
          classList: ["urlbarView-title"],
        },
        {
          name: "space",
          tag: "span",
          classList: ["urlbarView-prettyName"],
        },
        {
          name: "action",
          tag: "span",
          classList: ["urlbarView-action", "urlbarView-switchToTab"],
        },
      ],
    };
  }

  async onEngagement(queryContext, controller, details) {
    const panel = details.result?.payload.zenLastTabPanel;
    if (!panel) {
      return;
    }
    const win =
      details.element?.documentGlobal ??
      details.element?.ownerGlobal ??
      lazy.BrowserWindowTracker.getTopWindow();
    if (!win) {
      return;
    }
    const tab = win.gBrowser.tabs.find(t => t.linkedPanel == panel);
    if (tab && !tab.closing) {
      // Zen closes its ⌘T bar itself when the selected tab changes. Going
      // through Zen's helper also switches space (and container) if needed.
      if (win.gZenWorkspaces?.switchTabIfNeeded) {
        await win.gZenWorkspaces.switchTabIfNeeded(tab);
      } else {
        win.gBrowser.selectedTab = tab;
      }
    }
    win.gBrowser.selectedBrowser.focus();
  }

}

// --- Registration ---------------------------------------------------------------

function register() {
  const instance = ProvidersManager.getInstanceForSap("urlbar");
  if (!instance.getProvider(PROVIDER_NAME)) {
    instance.registerProvider(new ZenLastTabProvider());
  }
}

// This module loads early in startup; wait for the first browser window so the
// URL bar is set up before adding to it.
const onWindow = () => {
  Services.obs.removeObserver(onWindow, "browser-delayed-startup-finished");
  try {
    register();
  } catch (e) {
    console.error("Last tab in ⌘T: couldn't register", e);
  }
};
if (lazy.BrowserWindowTracker.getTopWindow()?.gBrowserInit?.delayedStartupFinished) {
  register();
} else {
  Services.obs.addObserver(onWindow, "browser-delayed-startup-finished");
}
