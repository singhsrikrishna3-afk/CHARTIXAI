"use client";

export default function DashboardLayout({ children }) {
  return (
    <div style={{ 
      height: "100vh", 
      width: "100vw", 
      margin: 0, 
      padding: 0, 
      overflow: "hidden", 
      background: "#ECE9D8", 
      fontFamily: "Tahoma, Arial, sans-serif",
      color: "#000000"
    }}>
      {children}
    </div>
  );
}
