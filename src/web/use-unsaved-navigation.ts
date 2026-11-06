import { useCallback, useEffect } from "react";
import { useBlocker } from "react-router-dom";

// Keep this separate from beforeunload: SPA links and history changes do not
// unload the document, but must still protect unconfirmed live edits.
export function useUnsavedNavigation(hasUnsavedChanges: () => boolean) {
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }) =>
    currentLocation.pathname !== nextLocation.pathname && hasUnsavedChanges(), [hasUnsavedChanges]));

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("You have unsaved drawing changes. Export or save your drawing before leaving. Leave this canvas and discard those changes?")) {
      blocker.proceed();
    } else blocker.reset();
  }, [blocker]);
}
