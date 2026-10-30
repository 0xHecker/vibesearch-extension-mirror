import { createRoot } from "react-dom/client";
import LocalLibrary from "./LocalLibrary";
import "@assets/styles/tailwind.css";

const root = document.getElementById("local-library");
if (root) createRoot(root).render(<LocalLibrary />);
