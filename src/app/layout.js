import './globals.css';

const APP_NAME = 'AI Terminal with Vulnerability Scanning & Patching System';

export const metadata = {
  title: APP_NAME,
  description:
    'AI-powered terminal for SSH/SFTP workflows with integrated vulnerability scanning, risk analysis, and patch synthesis.',
  applicationName: APP_NAME,
  icons: { icon: '/logo.svg' },
};

export const viewport = {
  themeColor: '#08090f',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
