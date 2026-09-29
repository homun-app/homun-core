import type { SVGProps } from "react";

export type ChannelBrandIconProps = SVGProps<SVGSVGElement> & {
  channelId: string;
  size?: number;
  className?: string;
};

export function ChannelBrandIcon({
  channelId,
  size = 20,
  className = "",
  ...props
}: ChannelBrandIconProps) {
  const normId = (channelId || "").toLowerCase().replace(/[-_]/g, "");

  switch (normId) {
    case "telegram":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <circle cx="12" cy="12" r="12" fill="#229ED9" />
          <path
            d="M5.4 11.9l11.4-4.7c.5-.2 1 .2.8.7l-1.9 9.2c-.1.6-.7.8-1.2.5l-3.3-2.4-1.6 1.5c-.2.2-.4.3-.7.3l.2-3.4 6.2-5.6c.3-.3-.1-.4-.4-.2L7.6 12.8 5.4 12.1c-.6-.2-.6-.7 0-.2z"
            fill="#ffffff"
          />
        </svg>
      );

    case "discord":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#5865F2" />
          <path
            d="M17.8 7.3a12.8 12.8 0 00-3.2-1 .1.1 0 00-.1.1c-.1.3-.3.7-.4.9a11.8 11.8 0 00-4.2 0c-.2-.2-.3-.6-.5-.9 0-.1-.1-.1-.1-.1a12.8 12.8 0 00-3.2 1c0 0-.1 0-.1.1A13.4 13.4 0 004 17.5s0 .1.1.1a12.9 12.9 0 003.9 2 .1.1 0 00.1 0c.3-.4.6-.9.8-1.4 0-.1 0-.1-.1-.1a8.5 8.5 0 01-1.2-.6c-.1 0-.1-.1 0-.2.1 0 .2-.1.3-.2a9.2 9.2 0 008.2 0c.1 0 .2.1.3.2 0 .1 0 .2-.1.2-.4.2-.8.4-1.2.6 0 0-.1.1 0 .1.2.5.5 1 .8 1.4 0 0 .1.1.1 0a12.9 12.9 0 003.9-2s.1 0 .1-.1c.7-3.9-.8-7.3-2-10.1 0-.1-.1-.1-.1-.1zM9.5 14.8c-.8 0-1.4-.7-1.4-1.6s.6-1.6 1.4-1.6c.8 0 1.4.7 1.4 1.6 0 .9-.6 1.6-1.4 1.6zm5 0c-.8 0-1.4-.7-1.4-1.6s.6-1.6 1.4-1.6c.8 0 1.4.7 1.4 1.6 0 .9-.6 1.6-1.4 1.6z"
            fill="#ffffff"
          />
        </svg>
      );

    case "slack":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <path
            d="M6 15a2 2 0 11-2-2h2v2zm1 0a2 2 0 114 0v5a2 2 0 11-4 0v-5zm2-8a2 2 0 112-2v2H9zm0 1a2 2 0 110 4H4a2 2 0 110-4h5zm8 2a2 2 0 112 2h-2V10zm-1 0a2 2 0 11-4 0V5a2 2 0 114 0v5zm-2 8a2 2 0 11-2 2v-2h2zm0-1a2 2 0 110-4h5a2 2 0 110 4h-5z"
            fill="#4A154B"
          />
          <path d="M5.5 15a1.5 1.5 0 11-1.5-1.5h1.5v1.5z" fill="#E01E5A" />
          <path d="M6.5 15a1.5 1.5 0 113 0v4.5a1.5 1.5 0 11-3 0v-4.5z" fill="#E01E5A" />
          <path d="M9 5.5a1.5 1.5 0 111.5-1.5v1.5H9z" fill="#36C5F0" />
          <path d="M9 6.5a1.5 1.5 0 110 3H4.5a1.5 1.5 0 110-3H9z" fill="#36C5F0" />
          <path d="M18.5 9a1.5 1.5 0 111.5 1.5h-1.5V9z" fill="#2EB67D" />
          <path d="M17.5 9a1.5 1.5 0 11-3 0V4.5a1.5 1.5 0 113 0V9z" fill="#2EB67D" />
          <path d="M15 18.5a1.5 1.5 0 11-1.5 1.5v-1.5H15z" fill="#ECB22E" />
          <path d="M15 17.5a1.5 1.5 0 110-3h4.5a1.5 1.5 0 110 3H15z" fill="#ECB22E" />
        </svg>
      );

    case "whatsapp":
    case "whatsappcloud":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <circle cx="12" cy="12" r="12" fill="#25D366" />
          <path
            d="M17.2 14.5c-.3-.1-1.6-.8-1.9-.9-.2-.1-.4-.1-.5.1-.2.2-.6.8-.8.9-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.6-1.5-1.9-.2-.3 0-.4.1-.5.1-.1.3-.3.4-.5.1-.2.2-.3.2-.4 0-.2-.1-.3-.2-.5-.1-.2-.5-1.3-.7-1.8-.2-.5-.4-.4-.5-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.6 1.1 2.8c.1.2 1.8 2.8 4.5 3.9.6.3 1.1.4 1.5.3.5-.1 1.6-.7 1.8-1.3.3-.6.3-1.2.2-1.3-.1-.1-.3-.2-.6-.3z"
            fill="#ffffff"
          />
          <path
            d="M12 4a8 8 0 00-6.9 12L4 20l4.2-1.1A8 8 0 1012 4zm0 14.6c-1.3 0-2.6-.4-3.7-1l-.3-.2-2.5.7.7-2.4-.2-.3a6.6 6.6 0 116 3.2z"
            fill="#ffffff"
          />
        </svg>
      );

    case "signal":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <circle cx="12" cy="12" r="12" fill="#3A76F0" />
          <path
            d="M12 5a7 7 0 00-7 7c0 1.5.5 2.9 1.4 4.1L5 20l4-1.3A7 7 0 1012 5zm0 12.6c-1.3 0-2.5-.4-3.5-1.1l-.3-.2-2 .6.6-2-.2-.4A5.6 5.6 0 1112 17.6z"
            fill="#ffffff"
          />
          <circle cx="9" cy="12" r="1" fill="#ffffff" />
          <circle cx="12" cy="12" r="1" fill="#ffffff" />
          <circle cx="15" cy="12" r="1" fill="#ffffff" />
        </svg>
      );

    case "matrix":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="4" fill="#040404" />
          <path
            d="M5.5 4h1v1.2H6v13.6h.5V20h-1V4zm13 0h-1v1.2h.5v13.6h-.5V20h1V4zM8.3 15.5V9.4h1.1l1.7 3.3 1.7-3.3h1.1v6.1h-1v-4.3l-1.4 2.8h-.8l-1.4-2.8v4.3h-1z"
            fill="#0DBD8B"
          />
        </svg>
      );

    case "mattermost":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#0058CC" />
          <path
            d="M12 4.5a3.5 3.5 0 00-3.5 3.5c0 1.1.5 2.1 1.3 2.7l-3.3 3.3a5.5 5.5 0 008.2 6.5l.8.8a6.5 6.5 0 00-9.2-9.2l3.4-3.4a3.5 3.5 0 012.3-.7z"
            fill="#ffffff"
          />
          <path
            d="M12 6a2 2 0 100 4 2 2 0 000-4z"
            fill="#1CE6D6"
          />
        </svg>
      );

    case "bluebubbles":
    case "imessage":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#34C759" />
          <path
            d="M12 5.5C8.4 5.5 5.5 8 5.5 11c0 1.8 1.1 3.4 2.8 4.3l-.7 2.7 3-1.3c.5.1.9.1 1.4.1 3.6 0 6.5-2.5 6.5-5.5s-2.9-5.8-6.5-5.8z"
            fill="#ffffff"
          />
        </svg>
      );

    case "homeassistant":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#18BCF2" />
          <path
            d="M12 5l-7 6.5V19h14v-7.5L12 5zm0 2.4l4.5 4.2V17h-9v-5.4L12 7.4z"
            fill="#ffffff"
          />
          <circle cx="12" cy="11.5" r="1.3" fill="#ffffff" />
          <circle cx="10" cy="14.5" r="1" fill="#ffffff" />
          <circle cx="14" cy="14.5" r="1" fill="#ffffff" />
          <path d="M12 11.5L10 14.5M12 11.5L14 14.5" stroke="#ffffff" strokeWidth="1.2" />
        </svg>
      );

    case "email":
    case "imap":
    case "smtp":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#EA4335" />
          <path
            d="M6 7h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1V8a1 1 0 011-1z"
            fill="#ffffff"
          />
          <path
            d="M5.5 8l6.5 4.5L18.5 8"
            stroke="#EA4335"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );

    case "sms":
    case "twilio":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#F22F46" />
          <circle cx="12" cy="12" r="7" stroke="#ffffff" strokeWidth="1.8" />
          <circle cx="9.5" cy="9.5" r="1.5" fill="#ffffff" />
          <circle cx="14.5" cy="9.5" r="1.5" fill="#ffffff" />
          <circle cx="9.5" cy="14.5" r="1.5" fill="#ffffff" />
          <circle cx="14.5" cy="14.5" r="1.5" fill="#ffffff" />
        </svg>
      );

    case "googlechat":
    case "google_chat":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#00AC47" />
          <rect x="5.5" y="7" width="9" height="7" rx="2" fill="#ffffff" />
          <rect x="9.5" y="10" width="9" height="7" rx="2" fill="#E6F4EA" />
        </svg>
      );

    case "dingtalk":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#007FFF" />
          <path
            d="M17.5 7.5L8 12.8l2.2-4.5 4.8-1.8-6.5 1.5-3.5 3.8 2 2.2L6 18l5-3 6.5-7.5z"
            fill="#ffffff"
          />
        </svg>
      );

    case "feishu":
    case "lark":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#00D6B9" />
          <path
            d="M6 15l5.5-8.5L18 10l-6.5 6.5L6 15z"
            fill="#ffffff"
          />
          <path
            d="M11.5 6.5L7 16l8-1-3.5-8.5z"
            fill="#0A66C2"
          />
        </svg>
      );

    case "wecom":
    case "weixin":
    case "wechat":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <circle cx="12" cy="12" r="12" fill="#07C160" />
          <circle cx="9.5" cy="10" r="5" fill="#ffffff" />
          <circle cx="15.5" cy="14" r="4" fill="#ffffff" />
          <circle cx="8" cy="9.5" r="0.8" fill="#07C160" />
          <circle cx="11" cy="9.5" r="0.8" fill="#07C160" />
          <circle cx="14.3" cy="13.5" r="0.7" fill="#07C160" />
          <circle cx="16.7" cy="13.5" r="0.7" fill="#07C160" />
        </svg>
      );

    case "qq":
    case "qqbot":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <circle cx="12" cy="12" r="12" fill="#12B7F5" />
          <path
            d="M12 6c-3 0-5 2.2-5 5.5 0 1.2.3 2.5.8 3.5-.5.6-1.3 1.5-.8 2.2.4.6 2.2.3 2.7.2.7.6 1.5.8 2.3.8s1.6-.2 2.3-.8c.5.1 2.3.4 2.7-.2.5-.7-.3-1.6-.8-2.2.5-1 .8-2.3.8-3.5C17 8.2 15 6 12 6z"
            fill="#ffffff"
          />
          <circle cx="10.5" cy="10.5" r="0.7" fill="#000000" />
          <circle cx="13.5" cy="10.5" r="0.7" fill="#000000" />
          <ellipse cx="12" cy="12.5" rx="1.5" ry="0.8" fill="#FF8200" />
        </svg>
      );

    case "yuanbao":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#FF5353" />
          <path
            d="M6 14c2-4 10-4 12 0l-2 3H8l-2-3z"
            fill="#FFE066"
          />
          <circle cx="12" cy="11" r="2.5" fill="#FFE066" />
        </svg>
      );

    case "irc":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#2E3440" />
          <path
            d="M10 7L8 17M16 7l-2 10M7 10h10M6 14h10"
            stroke="#88C0D0"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );

    default:
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          {...props}
        >
          <rect width="24" height="24" rx="5" fill="#4B5563" />
          <path
            d="M7 8h10M7 12h7M7 16h4"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
