"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";

export type Pin = { n: number; name: string; lat: number; lon: number };

function FitToPins({ pins }: { pins: Pin[] }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lon])), { padding: [40, 40], maxZoom: 16 });
  }, [map, pins]);
  return null;
}

const pinIcon = (n: number) =>
  L.divIcon({ className: "", html: `<span class="stop-pin">${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });

export default function RouteMap({ pins }: { pins: Pin[] }) {
  if (!pins.length) return null;
  return (
    <MapContainer
      center={[pins[0].lat, pins[0].lon]}
      zoom={15}
      scrollWheelZoom={false}
      className="h-full w-full"
      aria-label="Map of the route"
    >
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      <Polyline
        positions={pins.map((p) => [p.lat, p.lon])}
        pathOptions={{ className: "route-line", weight: 3, dashArray: "6 8", lineCap: "round" }}
      />
      {pins.map((p) => (
        <Marker key={p.n} position={[p.lat, p.lon]} icon={pinIcon(p.n)} title={`${p.n}. ${p.name}`} alt={`${p.n}. ${p.name}`} />
      ))}
      <FitToPins pins={pins} />
    </MapContainer>
  );
}
