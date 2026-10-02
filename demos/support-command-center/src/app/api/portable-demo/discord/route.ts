import { NextResponse } from "next/server";
import { runPortableDiscordTurn } from "../runner";

export async function POST() {
  return NextResponse.json(await runPortableDiscordTurn());
}
