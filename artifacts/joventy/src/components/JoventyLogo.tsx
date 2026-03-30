import { Link } from "wouter";

type LogoVariant = "dark" | "light" | "sidebar";
type LogoSize = "sm" | "md" | "lg";

interface JoventyLogoProps {
  variant?: LogoVariant;
  size?: LogoSize;
  className?: string;
  showText?: boolean;
  href?: string;
}

const sizeMap: Record<LogoSize, { img: string; container: string; text: string; gap: string }> = {
  sm: {
    img: "w-6 h-6 object-contain",
    container: "w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0",
    text: "font-serif text-xl font-bold leading-none",
    gap: "gap-2.5",
  },
  md: {
    img: "w-7 h-7 object-contain",
    container: "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
    text: "font-serif text-2xl font-bold leading-none",
    gap: "gap-3",
  },
  lg: {
    img: "w-9 h-9 object-contain",
    container: "w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0",
    text: "font-serif text-2xl font-bold leading-none",
    gap: "gap-3",
  },
};

const variantMap: Record<
  LogoVariant,
  { container: string; text: string }
> = {
  dark: {
    container: "bg-[#D4AF37]/20 border border-[#D4AF37]/40 hover:bg-[#D4AF37]/30 transition-colors",
    text: "text-white",
  },
  light: {
    container: "bg-transparent",
    text: "text-[#0A192F]",
  },
  sidebar: {
    container: "bg-[#0A192F]",
    text: "text-[#0A192F]",
  },
};

const IMG_SRC = "/icon.png";

export function JoventyLogo({
  variant = "light",
  size = "md",
  className = "",
  showText = true,
  href,
}: JoventyLogoProps) {
  const s = sizeMap[size];
  const v = variantMap[variant];

  const inner = (
    <span className={`flex items-center ${s.gap} ${className}`}>
      <span className={`${s.container} ${v.container}`}>
        <img src={IMG_SRC} alt="Joventy logo" className={s.img} />
      </span>
      {showText && (
        <span className={`${s.text} ${v.text}`}>Joventy</span>
      )}
    </span>
  );

  if (href !== undefined) {
    return <Link href={href}>{inner}</Link>;
  }

  return inner;
}
