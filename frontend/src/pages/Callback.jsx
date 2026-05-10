import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import LoadingScreen from "../components/LoadingScreen.jsx";

export default function Callback() {
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => {
      navigate("/home", { replace: true });
    }, 1000);
    return () => clearTimeout(t);
  }, [navigate]);

  return <LoadingScreen label="Signing you in" hint="Just a moment." />;
}
