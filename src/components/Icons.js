'use client';

/**
 * terminal.ai - icon set.
 *
 * Inline SVG rather than Unicode glyphs. Symbols like U+269A (keychain) and
 * U+2318 (command) fall back to whatever font Windows can find and render as
 * boxes or the wrong shape entirely, so every icon is drawn here instead.
 *
 * All of them inherit `currentColor` and size from the `size` prop, so a
 * button's colour rules apply without any per-icon styling.
 */

function Svg({ size = 18, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* --- navigation ----------------------------------------------------------- */

export const HostsIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="7" rx="1.5" />
    <rect x="3" y="13" width="18" height="7" rx="1.5" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Svg>
);

export const SnippetsIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M7.5 9.5 10 12l-2.5 2.5M12.5 15h4" />
  </Svg>
);

export const TunnelsIcon = (props) => (
  <Svg {...props}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </Svg>
);

export const KeychainIcon = (props) => (
  <Svg {...props}>
    <circle cx="8" cy="12" r="4" />
    <path d="M12 12h9M18 12v3.5M15.5 12v2.5" />
  </Svg>
);

export const ShieldCheckIcon = (props) => (
  <Svg {...props}>
    <path d="M12 3 5 6v5.5c0 4 3 7.5 7 9.5 4-2 7-5.5 7-9.5V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const ScannerIcon = (props) => (
  <Svg {...props}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    <circle cx="12" cy="12" r="4" />
  </Svg>
);

// A phone showing a code: the second factor lives on a device, not in the app.
export const TwoFactorIcon = (props) => (
  <Svg {...props}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M9.5 9.5h5M9.5 13h5M11 18.5h2" />
  </Svg>
);

export const LockIcon = (props) => (
  <Svg {...props}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
  </Svg>
);

/* --- actions -------------------------------------------------------------- */

export const PlusIcon = (props) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const CloseIcon = (props) => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const EditIcon = (props) => (
  <Svg {...props}>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="M14.5 6.5 17.5 9.5" />
  </Svg>
);

export const TrashIcon = (props) => (
  <Svg {...props}>
    <path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13M10.5 11v5M13.5 11v5" />
  </Svg>
);

export const ConnectIcon = (props) => (
  <Svg {...props}>
    <path d="M8 5.5 18 12 8 18.5V5.5Z" />
  </Svg>
);

export const RefreshIcon = (props) => (
  <Svg {...props}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4" />
  </Svg>
);

export const PlayIcon = (props) => (
  <Svg {...props}>
    <path d="M7 5.5 18.5 12 7 18.5V5.5Z" />
  </Svg>
);

export const SearchIcon = (props) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Svg>
);

export const SparkIcon = (props) => (
  <Svg {...props}>
    <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.8L12 18l-1.7-5.5L4.8 10.7 10.3 9 12 3.5Z" />
    <path d="M18.5 16.5 19.2 18.5 21 19.2 19.2 20 18.5 22 17.8 20 16 19.2 17.8 18.5 18.5 16.5Z" />
  </Svg>
);

export const SplitRightIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </Svg>
);

export const SplitDownIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 12h18" />
  </Svg>
);

export const FolderIcon = (props) => (
  <Svg {...props}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5v-10Z" />
  </Svg>
);

export const FileIcon = (props) => (
  <Svg {...props}>
    <path d="M6 3.5h7l5 5v12H6v-17Z" />
    <path d="M13 3.5v5h5" />
  </Svg>
);

export const LinkIcon = (props) => (
  <Svg {...props}>
    <path d="M10 13a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6" />
    <path d="M14 11a4 4 0 0 0-5.7 0L5.5 13.8a4 4 0 0 0 5.7 5.7L12.5 18" />
  </Svg>
);

export const UploadIcon = (props) => (
  <Svg {...props}>
    <path d="M12 19V6M7 11l5-5 5 5M5 20h14" />
  </Svg>
);

export const DownloadIcon = (props) => (
  <Svg {...props}>
    <path d="M12 5v13M7 13l5 5 5-5M5 20h14" />
  </Svg>
);

export const GearIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6" />
  </Svg>
);

export const ChevronIcon = (props) => (
  <Svg {...props}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const ArrowUpIcon = (props) => (
  <Svg {...props}>
    <path d="M12 19V6M6 12l6-6 6 6" />
  </Svg>
);

export const ArrowDownIcon = (props) => (
  <Svg {...props}>
    <path d="M12 5v13M6 12l6 6 6-6" />
  </Svg>
);

export const FolderPlusIcon = (props) => (
  <Svg {...props}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5v-10Z" />
    <path d="M11 13.5h4M13 11.5v4" />
  </Svg>
);

export const EyeIcon = (props) => (
  <Svg {...props}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const EyeOffIcon = (props) => (
  <Svg {...props}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20" />
  </Svg>
);

export const UserIcon = (props) => (
  <Svg {...props}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Svg>
);

export const KeyIcon = (props) => (
  <Svg {...props}>
    <path d="m21 2-2 2m-1.5 1.5L14 9M3 21l9-9M12 8a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z" />
  </Svg>
);

export const OS_OPTIONS = [
  { id: 'ubuntu', label: 'Ubuntu', color: '#E95420' },
  { id: 'debian', label: 'Debian', color: '#D70A53' },
  { id: 'centos', label: 'CentOS / RHEL', color: '#EE0000' },
  { id: 'alpine', label: 'Alpine', color: '#0D597F' },
  { id: 'arch', label: 'Arch Linux', color: '#1793D1' },
  { id: 'aws', label: 'AWS / Cloud', color: '#FF9900' },
  { id: 'freebsd', label: 'FreeBSD', color: '#AB2B28' },
  { id: 'windows', label: 'Windows', color: '#0078D7' },
  { id: 'linux', label: 'Generic Linux', color: '#4facfe' },
];

export function OsBadge({ os = 'ubuntu', size = 32, className = '' }) {
  const normalized = (os || 'ubuntu').toLowerCase();

  if (normalized.includes('deb')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#D70A53" />
        <path
          d="M16 8c4.4 0 8 3.6 8 8 0 3.2-1.9 6-4.6 7.2l-.8-1.8c2-1 3.4-3.1 3.4-5.4 0-3.3-2.7-6-6-6s-6 2.7-6 6c0 1.9 1 3.6 2.5 4.6l-1 1.7C9.6 21 8.5 18.6 8.5 16c0-4.4 3.6-8 7.5-8z"
          fill="#FFF"
        />
      </svg>
    );
  }

  if (normalized.includes('cent') || normalized.includes('rhel') || normalized.includes('redhat')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#EE0000" />
        <path d="M10 11h12v4H10zm3 6h6v4h-6z" fill="#FFF" />
      </svg>
    );
  }

  if (normalized.includes('alpin')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#0D597F" />
        <path d="m16 9 7 13h-4.5l-2.5-5-2.5 5H9z" fill="#FFF" />
      </svg>
    );
  }

  if (normalized.includes('arch')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#1793D1" />
        <path d="M16 8 8 23h4l2-4h4l2 4h4z" fill="#FFF" />
      </svg>
    );
  }

  if (normalized.includes('aws') || normalized.includes('cloud')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#232F3E" />
        <path d="m11 19 5 3 5-3M16 10v7" stroke="#FF9900" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      </svg>
    );
  }

  if (normalized.includes('win')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#0078D7" />
        <path d="M9 10.5 14.5 9.7v5.8H9zm6.5-.9L23 8.3v7.2h-7.5zM9 16.5h5.5v5.8L9 21.5zm6.5 0H23v7.2l-7.5-1.3z" fill="#FFF" />
      </svg>
    );
  }

  if (normalized.includes('freebsd')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#AB2B28" />
        <circle cx="12" cy="14" r="2" fill="#FFF" />
        <circle cx="20" cy="14" r="2" fill="#FFF" />
        <path d="M12 20c2 1.5 6 1.5 8 0" stroke="#FFF" strokeWidth="2" strokeLinecap="round" fill="none" />
      </svg>
    );
  }

  // Default: Ubuntu (orange circle with 3 segments and white dots)
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={`os-badge ${className}`}>
      <circle cx="16" cy="16" r="16" fill="#E95420" />
      <circle cx="16" cy="16" r="12" fill="none" stroke="#FFF" strokeWidth="2.2" strokeDasharray="6 3.5" />
      <circle cx="9" cy="16" r="2.2" fill="#FFF" />
      <circle cx="19.5" cy="10" r="2.2" fill="#FFF" />
      <circle cx="19.5" cy="22" r="2.2" fill="#FFF" />
    </svg>
  );
}

