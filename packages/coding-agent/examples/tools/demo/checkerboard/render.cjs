// Writes a checkerboard PNG to the working directory and returns it by path.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { crc32, deflateSync } = require("node:zlib");

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function checkerboardPng(cells, cellSize) {
	const size = cells * cellSize;
	const rows = [];
	for (let y = 0; y < size; y++) {
		const row = Buffer.alloc(1 + size);
		for (let x = 0; x < size; x++) {
			row[1 + x] = (Math.floor(x / cellSize) + Math.floor(y / cellSize)) % 2 === 0 ? 255 : 0;
		}
		rows.push(row);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 0; // grayscale
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

let raw = "";
process.stdin.on("data", (data) => (raw += data));
process.stdin.on("end", () => {
	const { input, cwd, callId } = JSON.parse(raw);
	const path = join(cwd, `checkerboard-${callId}.png`);
	writeFileSync(path, checkerboardPng(input.cells, 16));
	process.stdout.write(
		JSON.stringify({
			content: [
				{ type: "text", text: `${input.cells}x${input.cells} checkerboard` },
				{ type: "image", path },
			],
		}),
	);
});
