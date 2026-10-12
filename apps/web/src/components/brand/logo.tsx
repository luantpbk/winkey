import React from 'react';

interface BrandLogoProps {
  className?: string;
  showText?: boolean;
}

export function BrandLogo({ className = 'h-7 w-auto', showText = true }: BrandLogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 48 48"
        className="h-7 w-7 shrink-0 shadow-sm"
        fill="none"
        aria-hidden="true"
      >
        <rect width="48" height="48" rx="12" fill="#dc2626" />
        <polygon points="18,14 34,24 18,34" fill="#ffffff" />
      </svg>
      {showText && (
        <span className="text-xl font-bold tracking-tight text-gray-900 dark:text-white flex items-center">
          Winkey
          <span className="ml-1 text-[10px] uppercase font-bold text-red-500 tracking-wider">
            VN
          </span>
        </span>
      )}
    </div>
  );
}
