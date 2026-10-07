import PresentationScreen from "./presentation-screen";

type PresentationPageProps = {
  searchParams: Promise<{ presenter?: string | string[] }>;
};

export default async function PresentationPage({ searchParams }: PresentationPageProps) {
  const params = await searchParams;
  const presenterRequested = params.presenter === "1";
  return <PresentationScreen presenterRequested={presenterRequested} />;
}
