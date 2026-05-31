.PHONY: test test-rust test-browser browser-sync browser-test

test: test-browser test-rust

test-rust:
	cargo test --workspace

test-browser: browser-test

browser-sync:
	cd runtimes/browser-automation && npm install

browser-test:
	cd runtimes/browser-automation && npm test && npm run typecheck
