interface Props {
  size?: number;
  className?: string;
}

export function NovelFlowLogo({ size = 36, className = "" }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="NovelFlow Logo"
    >
      <rect x="2.5" y="2.5" width="59" height="59" rx="15" fill="#0F1117" stroke="rgba(229, 169, 94, 0.45)" strokeWidth="1.5" />
      <rect x="4" y="4" width="56" height="56" rx="13.5" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

      {/* Burnished gold 4-point spark centered above book cradle */}
      <path
        d="M32 10.5C33.4 17.5 36.5 20.6 43.5 22C36.5 23.4 33.4 26.5 32 33.5C30.6 26.5 27.5 23.4 20.5 22C27.5 20.6 30.6 17.5 32 10.5Z"
        fill="#E5A95E"
      />

      {/* Open book V-wings with smooth rounded outer corners */}
      <path
        d="M16 30.2C16 28.4 18.1 27.4 19.6 28.5L32 38.4L44.4 28.5C45.9 27.4 48 28.4 48 30.2V35.8L32 43.4L16 35.8V30.2Z"
        fill="#F4F5F8"
      />

      {/* Lower open-book base chevron */}
      <path
        d="M16 41L32 47.2L48 41V45.6L32 51.8L16 45.6V41Z"
        fill="#F4F5F8"
      />
    </svg>
  );
}

