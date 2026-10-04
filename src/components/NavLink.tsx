"use client";

import Link, { useLinkStatus } from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { buttonBaseClasses, buttonVariants } from "@/components/Button";

type NavLinkProps = Omit<ComponentProps<typeof Link>, "children"> & {
  pendingClassName?: string;
  /** Mirrors `Button`'s visual variants so links share the design system. */
  variant?: keyof typeof buttonVariants | "bare";
  children: ReactNode;
};

export function NavLink({
  href,
  pendingClassName,
  className,
  variant = "primary",
  children,
  ...rest
}: NavLinkProps) {
  return (
    <Link
      href={href}
      className={cn(
        variant === "bare" ? undefined : buttonBaseClasses,
        variant === "bare" ? undefined : buttonVariants[variant as keyof typeof buttonVariants],
        className,
      )}
      {...rest}
    >
      <PendingState pendingClassName={pendingClassName}>{children}</PendingState>
    </Link>
  );
}

function PendingState({
  pendingClassName,
  children,
}: {
  pendingClassName?: string;
  children: ReactNode;
}) {
  const { pending } = useLinkStatus();
  return (
    <span
      className={cn("inline-flex items-center justify-center gap-2", pending && pendingClassName)}
    >
      {children}
    </span>
  );
}
