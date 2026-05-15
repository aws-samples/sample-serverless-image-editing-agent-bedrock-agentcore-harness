import { LogOut } from 'lucide-react';

interface HeaderProps {
  email: string;
  onSignOut: () => void;
}

function Logo() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Stylized camera aperture / lens shape */}
      <rect width="28" height="28" rx="7" fill="#d97706" />
      <path
        d="M8 10.5C8 9.12 9.12 8 10.5 8H17.5C18.88 8 20 9.12 20 10.5V17.5C20 18.88 18.88 20 17.5 20H10.5C9.12 20 8 18.88 8 17.5V10.5Z"
        stroke="white"
        strokeWidth="1.5"
        fill="none"
      />
      <circle cx="14" cy="14" r="3.5" stroke="white" strokeWidth="1.5" fill="none" />
      <circle cx="14" cy="14" r="1.5" fill="white" />
      <circle cx="17.5" cy="9.5" r="1" fill="white" opacity="0.7" />
    </svg>
  );
}

export function Header({ email, onSignOut }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-5 py-3 shrink-0 bg-gray-900 border-b border-white/[0.06] z-10">
      <div className="flex items-center gap-2.5">
        <Logo />
        <h1 className="text-base font-semibold text-white tracking-tight">
          Serverless Image Editor on AgentCore Harness
        </h1>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-400 hidden sm:inline font-medium">
          {email}
        </span>
        <button
          onClick={onSignOut}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-all duration-200"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">Sign Out</span>
        </button>
      </div>
    </header>
  );
}
