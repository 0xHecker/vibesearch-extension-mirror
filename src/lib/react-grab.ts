import type { ReactGrabAPI } from "react-grab/core";

type ReactGrabWindow = Window &
  typeof globalThis & {
    __REACT_GRAB__?: ReactGrabAPI;
    __REACT_GRAB_DEV_READY__?: boolean;
  };

function showReactGrabToolbar(api: ReactGrabAPI) {
  api.setEnabled(true);
  api.setToolbarState({
    edge: "bottom",
    ratio: 0.5,
    collapsed: false,
    enabled: true,
    defaultAction: "copy",
  });
}

export function loadReactGrabInDevelopment() {
  if (import.meta.env.MODE !== "development") return;
  // Off by default; opt in with VITE_REACT_GRAB=on in the env file.
  if (import.meta.env.VITE_REACT_GRAB !== "on") return;

  void import("react-grab/core")
    .then(({ init }) => {
      const reactGrabWindow = window as ReactGrabWindow;
      const api =
        reactGrabWindow.__REACT_GRAB__ ??
        init({
          activationMode: "toggle",
          allowActivationInsideInput: true,
          keyHoldDuration: 100,
          telemetry: false,
        });

      reactGrabWindow.__REACT_GRAB__ = api;
      reactGrabWindow.__REACT_GRAB_DEV_READY__ = true;
      reactGrabWindow.dispatchEvent(
        new CustomEvent("react-grab:init", { detail: api })
      );

      showReactGrabToolbar(api);
      window.setTimeout(() => showReactGrabToolbar(api), 250);
    })
    .catch((error) => {
      console.warn("[react-grab] Failed to load React Grab.", error);
    });
}
