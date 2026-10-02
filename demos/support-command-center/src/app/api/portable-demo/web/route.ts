import { NextResponse } from "next/server";
import { runPortableWebTurn } from "../runner";

export async function POST() {
  return NextResponse.json(await runPortableWebTurn());
}
