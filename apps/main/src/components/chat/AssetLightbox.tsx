"use client";

// In-page lightbox for display assets (deck plans, ship images).
//
// Replaces the prior new-tab hyperlink (D-075) so the customer stays on the
// page: the bubble shows a small trigger + attribution, and clicking opens the
// image in a dismissible on-page modal instead of navigating to cruisemapper.com.
//
// We still HOT-LINK the image (img src = CruiseMapper's url), not host it, and
// surface attribution both inline and in the modal — the "their image, not
// ours" posture from D-075 is preserved; only the open-target changed
// (new browser tab -> on-page modal). CSP already allows https image loads
// (img-src 'self' data: blob: https:), so no policy change is needed.

import React from "react";
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { DisplayAsset } from "./renderMessageContent";

// Pure modal body — extracted so the image-url wiring and text escaping are
// unit-testable without driving the dialog open (DialogContent renders null
// while closed, so the <img> is absent from a closed-state static render).
export function AssetImage({ asset, label }: { asset: DisplayAsset; label: string }): JSX.Element {
  return (
    <div>
      <DialogTitle>{label}</DialogTitle>
      {/* External, DB/scraper-sourced url — next/image can't optimize an
          arbitrary host; raw img matches the group-invite hero precedent. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={asset.image_url}
        alt={asset.caption ?? label}
        className="w-full h-auto rounded mt-2"
      />
      <p className="mt-2 text-muted-foreground text-[12px]">{asset.attribution}</p>
    </div>
  );
}

export function AssetLightbox({ asset }: { asset: DisplayAsset }): JSX.Element {
  const label = `View ${asset.kind.replace(/_/g, " ")}`;
  return (
    <span className="inline-block my-0.5">
      <Dialog>
        <DialogTrigger asChild>
          <button type="button" className="text-primary underline cursor-pointer">
            {label} ⤢
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <AssetImage asset={asset} label={label} />
        </DialogContent>
      </Dialog>
      {asset.attribution ? (
        <span className="ml-1.5 text-muted-foreground text-[12px]">({asset.attribution})</span>
      ) : null}
    </span>
  );
}
