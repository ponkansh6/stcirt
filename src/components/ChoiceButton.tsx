import { ChoiceVariant } from "@/app/answer/choice-state";

interface ChoiceButtonProps {
  id: string;
  name: string;
  value: string;
  label: string;
  text: string;
  variant: ChoiceVariant;
  checked: boolean;
  onChange?: () => void;
  disabled?: boolean;
}

export default function ChoiceButton({
  id,
  name,
  value,
  label,
  text,
  variant,
  checked,
  onChange,
  disabled,
}: ChoiceButtonProps) {
  const getStyles = () => {
    switch (variant) {
      case "correct":
        return "border-success bg-success/15 text-success shadow-sm";
      case "selectedWrong":
        return "border-error bg-error/15 text-error shadow-sm";
      case "muted":
        return "border-border/60 bg-surface/40 opacity-50";
      case "selected":
        return "border-primary bg-primary/10 shadow-sm";
      case "idle":
      default:
        return "border-border bg-surface hover:border-primary hover:shadow-card";
    }
  };

  return (
    <label
      htmlFor={id}
      className={`flex w-full min-h-14 cursor-pointer items-center gap-3 rounded-card border p-3 text-left transition duration-200 ease-[var(--ease-out-soft)] focus-within:outline-none focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 ${disabled ? "cursor-not-allowed" : ""} ${getStyles()}`}
    >
      <input
        id={id}
        name={name}
        type="radio"
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="peer sr-only"
      />
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 font-bold text-sm ${checked ? "border-primary bg-primary text-on-primary" : "border-border bg-surface"}`}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words font-medium">{text}</span>
      {checked && (
        <span aria-hidden="true" className="shrink-0 text-sm font-bold text-primary">
          選択中
        </span>
      )}
    </label>
  );
}
