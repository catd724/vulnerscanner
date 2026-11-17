'use client';

/**
 * terminal.ai - brand mark.
 *
 * The original gradient tile with the >_ glyph, kept exactly as it was and
 * pulled out of page.js so every surface (header, unlock gate, empty states,
 * about) renders the same identity.
 *
 * To swap in a designed logo, replace public/logo.svg and set
 * NEXT_PUBLIC_BRAND_LOGO=/logo.svg - nothing else needs to change.
 */

const CUSTOM_LOGO = process.env.NEXT_PUBLIC_BRAND_LOGO || '/logo.svg';
const APP_NAME = 'AI Terminal';

export function BrandMark({ size = 32, className = '' }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={CUSTOM_LOGO}
      alt={APP_NAME}
      width={size}
      height={size}
      className={`brand-mark ${className}`}
      style={{ width: size, height: size, borderRadius: size * 0.22 }}
    />
  );
}

export function BrandWordmark({ size = 'md' }) {
  return (
    <span className={`brand-wordmark brand-wordmark-${size}`}>
      AI Terminal
    </span>
  );
}

export default function Brand({ size = 32, wordmarkSize = 'md', showWordmark = true }) {
  return (
    <span className="brand">
      <BrandMark size={size} />
      {showWordmark && <BrandWordmark size={wordmarkSize} />}
    </span>
  );
}
