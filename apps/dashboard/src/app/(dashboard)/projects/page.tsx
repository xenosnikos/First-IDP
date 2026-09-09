import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ProjectsGrid } from "@/components/projects/projects-grid";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

// Projects = repos & what the platform knows about them (docs/NEBULA.md
// §N3.4). Auto-populated: org repos ∪ cluster-referenced repos ∪ registered
// rows. Registration (project.create) is optional enrichment, never required.
export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  return <ProjectsGrid />;
}
