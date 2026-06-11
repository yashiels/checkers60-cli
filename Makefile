.PHONY: install fmt lint test build ci clean

node_modules: package.json
	npm install

install: node_modules

fmt: node_modules
	npm run fmt

lint: node_modules
	npm run lint

test: node_modules
	npm run test

build: node_modules
	npm run build

ci: lint test

clean:
	rm -rf dist
