import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export const FilesIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M6 2.75h8l4 4v14.5H6z" /><path d="M14 2.75v4h4" /><path d="M3 6.5v14.75h11" /></IconBase>
)
export const BrowserIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="2.75" y="4" width="18.5" height="16" rx="2" /><path d="M2.75 8.25h18.5" /><path d="M6 6.15h.01M9 6.15h.01" /></IconBase>
)
export const GridIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></IconBase>
)
export const ChatIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M4 4h16v12H8l-4 4z" /><path d="M8 8h8M8 12h5" /></IconBase>
)
export const GitIcon = (props: IconProps) => (
  <IconBase {...props}><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 6.5c5 0 8 2 8 6.5v4" /></IconBase>
)
export const SettingsIcon = (props: IconProps) => (
  <IconBase {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .35 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.55 19.4a1.7 1.7 0 0 0-1.88.35l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.4v-4h.1A1.7 1.7 0 0 0 4.2 8.55a1.7 1.7 0 0 0-.35-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.55 4.2a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.4h4v.1A1.7 1.7 0 0 0 15 4.2a1.7 1.7 0 0 0 1.88-.35l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.55a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1A1.7 1.7 0 0 0 19.4 15z" /></IconBase>
)
export const CompanyIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 21V7l8-4 8 4v14" />
    <path d="M2.5 21h19M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M10 21v-3h4v3" />
  </IconBase>
)
export const ChevronRightIcon = (props: IconProps) => <IconBase {...props}><path d="m9 18 6-6-6-6" /></IconBase>
export const ChevronDownIcon = (props: IconProps) => <IconBase {...props}><path d="m6 9 6 6 6-6" /></IconBase>
export const SidebarToggleIcon = ({ collapsed = false, ...props }: { collapsed?: boolean } & IconProps) => (
  <IconBase {...props}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="M16 3.5v17" />
    <path d={collapsed ? 'm12.5 18-6-6 6-6' : 'm6.5 18 6-6-6-6'} />
  </IconBase>
)
export const FolderIcon = (props: IconProps) => <IconBase {...props}><path d="M3 5h7l2 2h9v12H3z" /></IconBase>
export const FileIcon = (props: IconProps) => <IconBase {...props}><path d="M6 2.75h8l4 4v14.5H6z" /><path d="M14 2.75v4h4" /></IconBase>
export const ArrowLeftIcon = (props: IconProps) => <IconBase {...props}><path d="m15 18-6-6 6-6" /></IconBase>
export const ArrowRightIcon = (props: IconProps) => <IconBase {...props}><path d="m9 18 6-6-6-6" /></IconBase>
export const ReloadIcon = (props: IconProps) => <IconBase {...props}><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></IconBase>
export const CameraIcon = (props: IconProps) => <IconBase {...props}><path d="M4 7h3l1.5-2h7L17 7h3v12H4z" /><circle cx="12" cy="13" r="3.5" /></IconBase>
export const StopIcon = (props: IconProps) => <IconBase {...props}><rect x="6" y="6" width="12" height="12" rx="1" /></IconBase>
export const SparkIcon = (props: IconProps) => <IconBase {...props}><path d="m12 2 1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z" /></IconBase>
export const CloseIcon = (props: IconProps) => <IconBase {...props}><path d="m7 7 10 10M17 7 7 17" /></IconBase>
export const ExternalIcon = (props: IconProps) => <IconBase {...props}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v7H4V6h7" /></IconBase>
export const SunIcon = (props: IconProps) => <IconBase {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" /></IconBase>
export const MoonIcon = (props: IconProps) => <IconBase {...props}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></IconBase>
export const MonitorIcon = (props: IconProps) => <IconBase {...props}><rect x="2.75" y="4.5" width="18.5" height="12.5" rx="1.5" /><path d="M9 20h6M12 17v3" /></IconBase>
export const RotateIcon = (props: IconProps) => <IconBase {...props}><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></IconBase>
export const PencilIcon = (props: IconProps) => <IconBase {...props}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /><path d="m15 5 4 4" /></IconBase>
export const TrashIcon = (props: IconProps) => <IconBase {...props}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></IconBase>
export const EyeIcon = (props: IconProps) => <IconBase {...props}><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" /><circle cx="12" cy="12" r="3" /></IconBase>
export const EyeOffIcon = (props: IconProps) => <IconBase {...props}><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><path d="M2 2l20 20" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /></IconBase>
export const PlusIcon = (props: IconProps) => <IconBase {...props}><path d="M5 12h14M12 5v14" /></IconBase>
export const ArchiveIcon = (props: IconProps) => <IconBase {...props}><rect x="2.75" y="3.25" width="18.5" height="5" rx="1" /><path d="M4.5 8.25V19a1.75 1.75 0 0 0 1.75 1.75h11.5A1.75 1.75 0 0 0 19.5 19V8.25" /><path d="M9.75 12.25h4.5" /></IconBase>
export const MoreHorizontalIcon = (props: IconProps) => <IconBase {...props}><circle cx="5" cy="12" r="1.1" fill="currentColor" /><circle cx="12" cy="12" r="1.1" fill="currentColor" /><circle cx="19" cy="12" r="1.1" fill="currentColor" /></IconBase>
export const BoxIcon = (props: IconProps) => <IconBase {...props}><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></IconBase>
export const PlugIcon = (props: IconProps) => <IconBase {...props}><path d="M12 22v-5M9 8V2M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" /></IconBase>
export const PuzzleIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M19 13h-2.2a2.8 2.8 0 1 0-5.6 0H9v-2.2a2.8 2.8 0 1 0-5.6 0H2V5a2 2 0 0 1 2-2h5.8v1.4a2.8 2.8 0 1 0 5.6 0V3H20a2 2 0 0 1 2 2v5.8h-1.4a2.8 2.8 0 1 0 0 5.6H22V20a2 2 0 0 1-2 2h-5.8v-1.4a2.8 2.8 0 1 0-5.6 0V22H4a2 2 0 0 1-2-2v-4.6h1.4a2.8 2.8 0 1 0 0-5.6" />
  </IconBase>
)
export const ShieldIcon = (props: IconProps) => <IconBase {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /></IconBase>
export const BrainIcon = (props: IconProps) => <IconBase {...props}><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /></IconBase>
export const ContextIcon = (props: IconProps) => <IconBase {...props}><path d="M12 3.25 21 8l-9 4.75L3 8z" /><path d="m4.6 12.2 7.4 3.9 7.4-3.9" /><path d="m4.6 16.1 7.4 3.9 7.4-3.9" /></IconBase>
export const ArrowUpIcon = (props: IconProps) => <IconBase {...props}><path d="m5 12 7-7 7 7M12 19V5" /></IconBase>
export const CheckIcon = (props: IconProps) => <IconBase {...props}><path d="m20 6-11 11-5-5" /></IconBase>
export const QualityIcon = (props: IconProps) => <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.6 2.6L16.5 9" /></IconBase>
export const SpinnerIcon = (props: IconProps) => <IconBase {...props} className={`animate-spin ${props.className || ''}`}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></IconBase>
export const SearchIcon = (props: IconProps) => <IconBase {...props}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></IconBase>
export const TerminalIcon = (props: IconProps) => <IconBase {...props}><path d="m5 7 5 5-5 5" /><path d="M12 17h7" /></IconBase>
export const CopyIcon = (props: IconProps) => <IconBase {...props}><rect x="9" y="9" width="12" height="12" rx="1.5" /><path d="M5 15H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 3h9A1.5 1.5 0 0 1 14.5 4.5V5" /></IconBase>
export const CrosshairIcon = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    <circle cx="12" cy="12" r="1" />
  </IconBase>
)
export const HomeIcon = (props: IconProps) => <IconBase {...props}><path d="m3 10.5 9-7 9 7" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5.5h4V20" /></IconBase>
export const DownloadIcon = (props: IconProps) => (
  <IconBase {...props}><path d="M12 3v11" /><path d="m7.5 10 4.5 4.5L16.5 10" /><path d="M4 17v2.25A1.75 1.75 0 0 0 5.75 21h12.5A1.75 1.75 0 0 0 20 19.25V17" /></IconBase>
)
export const BlocksIcon = (props: IconProps) => (
  <IconBase {...props}><rect x="3" y="3" width="7.5" height="7.5" rx="1.2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.2" /><path d="M17.25 13.75v7M13.5 17.5h7.5" /></IconBase>
)
