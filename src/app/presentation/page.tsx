import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_PRESENTATION_COOKIE,
  isAdminPresentationAuthConfigured,
  verifyAdminPresentationSession,
} from "@/lib/presentation/admin-auth";
import PresentationScreen from "./presentation-screen";

type PresentationPageProps = {
  searchParams: Promise<{ presenter?: string | string[] }>;
};

export default async function PresentationPage({ searchParams }: PresentationPageProps) {
  const params = await searchParams;
  const presenterRequested = params.presenter === "1";

  if (presenterRequested) {
    const token = (await cookies()).get(ADMIN_PRESENTATION_COOKIE)?.value;
    if (!isAdminPresentationAuthConfigured() || !verifyAdminPresentationSession(token)) {
      redirect("/admin/presentation");
    }
  }

  return <PresentationScreen presenterRequested={presenterRequested} />;
}
