import * as React from "react";
import { Info } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@src/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@src/components/ui/popover";
import { SectionHeading, SettingGroup, SettingRow, SettingSwitch } from "../SettingsPrimitives";
import {
  CLIPBOARD_FORMATS,
  clipboardFormatPreview,
  getClipboardFormat,
  setClipboardFormat,
  type ClipboardFormat,
} from "../clipboard-format";
import { OPEN_ON_NEW_TAB_STORAGE_KEY, setOpenOnNewTab } from "@src/common/new-tab-pref";
import {
  DEFAULT_IMPORT_SETTINGS,
  normalizeImportSettings,
  type ImportSettings,
} from "@src/common/import-settings";

type RuntimeResponse<T> = {
  success?: boolean;
  payload?: T;
  error?: string;
};

const callImportSettings = async (
  type: "IMPORT_GET_SETTINGS" | "IMPORT_SET_SETTINGS",
  payload?: unknown
): Promise<ImportSettings> => {
  const response = (await chrome.runtime.sendMessage({
    target: "background",
    type,
    payload,
  })) as RuntimeResponse<ImportSettings>;

  if (!response?.success) {
    throw new Error(response?.error || `${type} failed`);
  }

  return normalizeImportSettings(response.payload);
};

export function MiscSection() {
  const [format, setFormat] = React.useState<ClipboardFormat>(getClipboardFormat);
  const [openOnNewTab, setOpenOnNewTabState] = React.useState(false);
  const [importSettings, setImportSettingsState] =
    React.useState<ImportSettings>(DEFAULT_IMPORT_SETTINGS);

  React.useEffect(() => {
    let active = true;
    void chrome.storage.local.get(OPEN_ON_NEW_TAB_STORAGE_KEY).then((result) => {
      if (active) setOpenOnNewTabState(result?.[OPEN_ON_NEW_TAB_STORAGE_KEY] === true);
    });
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    let active = true;
    void callImportSettings("IMPORT_GET_SETTINGS")
      .then((settings) => {
        if (active) setImportSettingsState(settings);
      })
      .catch((error) => {
        console.error("[Settings] failed to load import settings", error);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleFormatChange = (value: string) => {
    const next = value as ClipboardFormat;
    setFormat(next);
    setClipboardFormat(next);
  };

  const handleToggleNewTab = (next: boolean) => {
    setOpenOnNewTabState(next);
    void setOpenOnNewTab(next);
  };

  const handleToggleCloseTabsAfterSave = (next: boolean) => {
    const previous = importSettings;
    setImportSettingsState((current) => ({ ...current, closeTabsAfterSave: next }));

    void callImportSettings("IMPORT_SET_SETTINGS", { closeTabsAfterSave: next })
      .then(setImportSettingsState)
      .catch((error) => {
        console.error("[Settings] failed to update import settings", error);
        setImportSettingsState(previous);
      });
  };

  return (
    <div>
      <SectionHeading title="Misc" description="Small preferences that tune how VibeSearch behaves." />

      <SettingGroup>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Clipboard format
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Preview clipboard format"
                    className="grid size-4 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:text-foreground-secondary focus-visible:text-foreground-secondary"
                  >
                    <Info className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 p-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-tertiary">
                    Clipboard content preview
                  </p>
                  <pre className="max-h-56 overflow-auto scrollbar-subtle whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground-secondary">
                    {clipboardFormatPreview(format)}
                  </pre>
                </PopoverContent>
              </Popover>
            </span>
          }
          description="Set the format used when copying links to the clipboard."
        >
          <Select value={format} onValueChange={handleFormatChange}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLIPBOARD_FORMATS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          title="Close tabs after saving"
          description="Close browser tabs automatically after Save tabs stores them in VibeSearch."
        >
          <SettingSwitch
            checked={importSettings.closeTabsAfterSave}
            onCheckedChange={handleToggleCloseTabsAfterSave}
            label="Close browser tabs after saving them"
          />
        </SettingRow>

        <SettingRow
          title="Open in new tab"
          description="Open VibeSearch when you open a new browser tab. Turn off to keep your browser's default new tab."
        >
          <SettingSwitch
            checked={openOnNewTab}
            onCheckedChange={handleToggleNewTab}
            label="Open VibeSearch when opening a new tab"
          />
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
