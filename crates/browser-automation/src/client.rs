use crate::{
    BrowserAutomationError, BrowserMethod, BrowserRequest, BrowserResponse, BrowserResult,
};
use serde_json::Value;
use std::cell::Cell;

pub trait BrowserTransport {
    fn send(&self, request: &BrowserRequest) -> BrowserResult<String>;
}

pub struct BrowserAutomationClient<T> {
    transport: T,
    next_id: Cell<u64>,
}

impl<T: BrowserTransport> BrowserAutomationClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            next_id: Cell::new(1),
        }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    pub fn call(&self, method: BrowserMethod, params: Value) -> BrowserResult<Value> {
        Ok(self.call_response(method, params)?.result()?.clone())
    }

    pub fn call_response(
        &self,
        method: BrowserMethod,
        params: Value,
    ) -> BrowserResult<BrowserResponse> {
        let id = format!("browser_req_{}", self.next_id.get());
        self.next_id.set(self.next_id.get() + 1);
        let request = BrowserRequest::new(id.clone(), method, params);
        let line = self.transport.send(&request)?;
        let response: BrowserResponse = serde_json::from_str(&line)?;
        if response.id() != id {
            return Err(BrowserAutomationError::InvalidResponse(format!(
                "response id mismatch:{} != {}",
                response.id(),
                id
            )));
        }
        Ok(response)
    }
}
