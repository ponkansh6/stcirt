"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import styles from "./question-photo-preview.module.css";

export type QuestionPhoto = {
  src: string;
  alt: string;
  label: string;
};

const sconePhoto: QuestionPhoto = {
  src: "/images/questions/q5-mandarin-oriental-scone.jpg",
  alt: "マンダリンオリエンタルホテルのスコーン",
  label: "マンダリンオリエンタルホテルのスコーンの写真",
};

export function getQuestionPhoto(questionId: number, activity: string): QuestionPhoto | null {
  const normalizedActivity = activity.trim().replace(/\s+/g, " ");
  if (questionId === 5 && normalizedActivity === "マンダリンオリエンタルホテルのスコーンを食べる") {
    return sconePhoto;
  }
  return null;
}

export function QuestionPhotoPreview({
  photo,
  onOpen,
}: {
  photo: QuestionPhoto;
  onOpen: (photo: QuestionPhoto, trigger: HTMLButtonElement) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.previewButton}
      aria-label={`${photo.label}を拡大表示`}
      onClick={() => {
        if (buttonRef.current) onOpen(photo, buttonRef.current);
      }}
    >
      <Image src={photo.src} width={961} height={1280} sizes="48px" alt={photo.alt} />
    </button>
  );
}

export function QuestionPhotoDialog({
  photo,
  trigger,
  onClose,
}: {
  photo: QuestionPhoto | null;
  trigger: HTMLButtonElement | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !photo) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeButtonRef.current?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!dialog.open) return;
      const bounds = dialog.getBoundingClientRect();
      const insideDialog =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (!insideDialog) onCloseRef.current();
    };
    document.addEventListener("click", closeOnOutsideClick, true);
    return () => {
      document.removeEventListener("click", closeOnOutsideClick, true);
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      trigger?.focus();
    };
  }, [photo, trigger]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      tabIndex={-1}
      aria-label={photo?.label ?? "写真"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable.item(0);
        const last = focusable.item(focusable.length - 1);
        const activeElement = document.activeElement;
        if (
          !dialog.contains(activeElement) ||
          (!event.shiftKey && activeElement === last) ||
          (event.shiftKey && activeElement === first)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
    >
      {photo && (
        <div className={styles.dialogContent}>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="写真を閉じる"
          >
            閉じる
          </button>
          <Image
            className={styles.fullImage}
            src={photo.src}
            width={961}
            height={1280}
            sizes="(max-width: 640px) 90vw, 640px"
            alt={photo.alt}
          />
        </div>
      )}
    </dialog>
  );
}
