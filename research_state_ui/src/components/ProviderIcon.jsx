/**
 * ProviderIcon — the provider's real logo mark in a small tile.
 *
 * Logo bitmaps live in public/providers/<name>.png (64px marks fetched from
 * each vendor's own site), so they ship with the UI build — no external
 * requests at render time. The tile keeps a soft neutral wash so light-on-
 * transparent marks stay readable in both themes; a missing file falls back
 * to a two-letter monogram rather than a broken image.
 */

import { useState } from 'react';

const LABELS = {
  lambda_labs: 'LL',
  thunder_compute: 'TC',
  hyperstack: 'HS',
  digitalocean: 'DO',
  verda: 'VD',
  voltage_park: 'VP',
  tensordock: 'TD',
  aws: 'AWS',
  gcp: 'GC',
  azure: 'AZ',
  // No shipped mark: monogram only.
  modal: 'MD',
  local: 'LC',
  fake: 'FK',
};

// `inset` is the tile's total padding around the mark: 8 for the 30px setup
// tiles, 4 for the 16px inline marks on the fleet table's rows.
export default function ProviderIcon({ provider, size = 30, inset = 8 }) {
  const [broken, setBroken] = useState(false);
  const src = `${import.meta.env.BASE_URL}providers/${provider}.png`;
  const small = size <= 20;
  return (
    <span
      className={`sbxp-icon${small ? ' sbxp-icon--sm' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {broken ? (
        <span className="sbxp-icon-fallback">{LABELS[provider] || '?'}</span>
      ) : (
        <img
          src={src}
          width={size - inset}
          height={size - inset}
          alt=""
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}
