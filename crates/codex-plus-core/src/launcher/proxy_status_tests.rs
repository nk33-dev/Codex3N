use super::*;
use crate::protocol_proxy::UpstreamWireApi;
use std::time::Duration;

#[derive(Default)]
struct CaptureSink(Vec<u8>);

impl SseSink for CaptureSink {
    async fn send(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.0.extend_from_slice(bytes);
        Ok(())
    }
}

async fn assert_completed_without_eof(wire: UpstreamWireApi, prefix: &[u8], chunks: &[&str]) {
    let _guard = crate::request_log::request_log_test_guard();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let chunks: Vec<String> = chunks.iter().map(|chunk| chunk.to_string()).collect();
    let (release, held) = tokio::sync::oneshot::channel();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        for chunk in chunks {
            tokio::time::sleep(Duration::from_millis(10)).await;
            socket
                .write_all(format!("{:X}\r\n{chunk}\r\n", chunk.len()).as_bytes())
                .await
                .unwrap();
        }
        // 不发 HTTP 终止块，模拟模型已结束但上游仍保持响应流。
        let _ = held.await;
    });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{address}/stream"))
        .send()
        .await
        .unwrap();
    let mut log = ProxyRequestLog::begin("POST", "/responses", None, None);
    let id = log.entry.id.clone();
    assert!(
        crate::request_log::running_requests()
            .iter()
            .any(|row| row.id == id)
    );
    let mut sink = CaptureSink::default();
    let mut final_usage = None;
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let result = forward_protocol_proxy_stream_for_client_with_live_request(
            &mut sink,
            prefix,
            response,
            wire,
            None,
            None,
            false,
            Some(&id),
            &mut final_usage,
        )
        .await;
        if let Ok((failure, usage, detail, _)) = &result {
            log.record_stream(failure.as_deref(), usage.clone(), detail.clone());
        }
        drop(log);
        result
    })
    .await;
    let _ = release.send(());
    upstream.await.unwrap();

    let (failure, usage, _, _) = result
        .expect("收到协议完成事件后必须结束，不能等待 HTTP EOF")
        .unwrap();
    assert_eq!(failure, None, "{wire:?}");
    assert!(
        !crate::request_log::running_requests()
            .iter()
            .any(|row| row.id == id)
    );
    let usage = usage.expect("完成前的用量必须保留");
    assert_eq!(usage.input_tokens, 12);
    assert_eq!(usage.output_tokens, 3);
    assert_eq!(usage.cached_tokens, 4);
    let output = String::from_utf8(sink.0).unwrap();
    assert_eq!(
        output.matches("event: response.completed").count(),
        1,
        "{output}"
    );
    assert!(!output.contains("event: response.failed"), "{output}");
    if wire == UpstreamWireApi::Responses {
        assert_eq!(final_usage, Some(usage));
    }
}

#[tokio::test]
async fn responses_completion_clears_live_request_without_http_eof() {
    let completed = concat!(
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",",
        "\"usage\":{\"input_tokens\":12,\"output_tokens\":3,",
        "\"input_tokens_details\":{\"cached_tokens\":4}}}}\n\n"
    );
    assert_completed_without_eof(
        UpstreamWireApi::Responses,
        &[],
        &[
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
            &completed[..40],
            &completed[40..],
        ],
    )
    .await;
    assert_completed_without_eof(UpstreamWireApi::Responses, completed.as_bytes(), &[]).await;
}

#[tokio::test]
async fn chat_done_clears_live_request_and_keeps_trailing_usage() {
    assert_completed_without_eof(
        UpstreamWireApi::ChatCompletions,
        &[],
        &[
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":4}}}\n\n",
            "data: [DO",
            "NE]\n\n",
        ],
    )
    .await;
}

#[tokio::test]
async fn anthropic_message_stop_clears_live_request_without_http_eof() {
    assert_completed_without_eof(
        UpstreamWireApi::AnthropicMessages,
        &[],
        &[
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_live\",\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":4}}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_",
            "stop\"}\n\n",
        ],
    )
    .await;
}
